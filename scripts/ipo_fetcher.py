#!/usr/bin/env python3
"""IPO 백테스팅 데이터 수집 스크립트

1. KIND(KRX 공시) → 2023-06-26 이후 상장 종목 목록 + 상장일
2. finuts.co.kr    → 공모가 (상장일 기준 매핑)
3. FinanceDataReader → 일봉 OHLCV
결과: docs/data/ipo_data.json
"""

import io, json, time, re, socket, requests
import pandas as pd
import FinanceDataReader as fdr
from datetime import datetime
from pathlib import Path
from bs4 import BeautifulSoup

# FDR 네이버 내부 requests에 timeout이 없어 CI에서 행이 걸릴 수 있음 → 전역 소켓 타임아웃
socket.setdefaulttimeout(15)

IPO_START = "2023-06-26"
OUT = Path("docs/data/ipo_data.json")
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"}


# ──────────────────────────────────────────
# 1. KIND에서 상장 종목 목록 (상장일 포함)
# ──────────────────────────────────────────

def get_kind_listing(market_type: str, market_label: str) -> pd.DataFrame:
    """
    market_type: 'stockMkt' (KOSPI) | 'kosdaqMkt' (KOSDAQ)
    """
    url = "http://kind.krx.co.kr/corpgeneral/corpList.do"
    params = {"method": "download", "searchType": "13", "marketType": market_type}
    # KIND는 간헐적으로 타임아웃·연결 거부가 발생 → 재시도 (CI 실패의 주원인)
    last_err: Exception | None = None
    for attempt in range(1, 4):
        try:
            resp = requests.get(url, params=params, headers=HEADERS, timeout=30)
            resp.raise_for_status()
            df = pd.read_html(io.StringIO(resp.content.decode("euc-kr")))[0]
            df["Market"] = market_label
            return df
        except Exception as e:
            last_err = e
            print(f"  KIND {market_label} 요청 실패 ({attempt}/3): {e}")
            time.sleep(10 * attempt)
    raise RuntimeError(f"KIND {market_label} 목록 조회 3회 실패") from last_err


def get_listing_df() -> pd.DataFrame:
    kospi  = get_kind_listing("stockMkt",  "KOSPI")
    kosdaq = get_kind_listing("kosdaqMkt", "KOSDAQ")
    df = pd.concat([kospi, kosdaq], ignore_index=True)

    # 열 이름 정규화 (EUC-KR 디코딩 결과에 따라 다를 수 있음)
    col_map = {}
    for c in df.columns:
        lc = c.strip()
        if "회사" in lc or "종목명" in lc:   col_map[c] = "name"
        elif "코드" in lc:                   col_map[c] = "ticker"
        elif "상장일" in lc:                 col_map[c] = "ipo_date"
    df = df.rename(columns=col_map)

    needed = {"name", "ticker", "ipo_date"}
    missing = needed - set(df.columns)
    if missing:
        raise RuntimeError(f"KIND 응답에서 필요 열 누락: {missing}\n실제 열: {list(df.columns)}")

    df["ticker"] = df["ticker"].astype(str).str.zfill(6)
    df["ipo_date"] = pd.to_datetime(df["ipo_date"], errors="coerce")
    df = df[df["ipo_date"] >= IPO_START].copy()
    # KIND 목록에 같은 종목이 중복 수록되는 경우가 있음 (예: 조선내화)
    df = df.drop_duplicates(subset="ticker", keep="first")
    df = df.sort_values("ipo_date").reset_index(drop=True)
    print(f"  KIND 상장 목록: {len(df)}개 "
          f"(KOSPI {(df['Market']=='KOSPI').sum()}, "
          f"KOSDAQ {(df['Market']=='KOSDAQ').sum()})")
    return df


# ──────────────────────────────────────────
# 2. 공모가 — finuts.co.kr API
# ──────────────────────────────────────────

def get_finuts_ipo_prices() -> dict[str, int]:
    """
    finuts.co.kr의 ipoListQuery.php API에서
    {상장일: 공모가} 딕셔너리를 반환.
    KIND 데이터와 상장일로 매핑하여 종목코드별 공모가를 확인.
    """
    url = "https://www.finuts.co.kr/html/task/ipo/ipoListQuery.php"
    headers = {
        **HEADERS,
        "Referer": "https://www.finuts.co.kr/html/ipo/ipoList.php",
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Requested-With": "XMLHttpRequest",
    }
    # {상장일: [(회사명, 공모가), ...]}
    date_map: dict[str, list[tuple[str, int]]] = {}
    try:
        resp = requests.post(url, data={"active": "ipo-011", "search_text": ""},
                             headers=headers, timeout=30)
        resp.raise_for_status()
        items = resp.json().get("data", [])
        for item in items:
            ipo_date = item.get("IPO_DATE", "")
            pss_prc  = item.get("PSS_PRC", "")
            ent_nm   = item.get("ENT_NM", "")
            if ipo_date in ("9999-99-99", "", None):
                continue
            if not pss_prc:
                continue
            try:
                price = int(str(pss_prc).replace(",", ""))
            except ValueError:
                continue
            if price <= 0:
                continue
            date_map.setdefault(ipo_date, []).append((ent_nm, price))
        print(f"  finuts 공모가: {sum(len(v) for v in date_map.values())}개 항목 "
              f"({len(date_map)}개 날짜)")
    except Exception as e:
        print(f"  finuts API 실패: {e}")
    return date_map


def match_ipo_price(date_map: dict, ipo_date: str, name: str) -> int | None:
    """
    finuts 데이터와 (상장일, 회사명)으로 공모가를 매핑.
    같은 날 1개면 바로 반환, 여러 개면 이름 유사도로 매핑.
    """
    candidates = date_map.get(ipo_date, [])
    if not candidates:
        return None
    if len(candidates) == 1:
        return candidates[0][1]

    # 이름 정규화 후 비교 (공백·특수문자 제거, 소문자)
    def normalize(s: str) -> str:
        return re.sub(r"[\s\-_·]", "", s).lower()

    norm_name = normalize(name)
    for cand_name, price in candidates:
        if normalize(cand_name) == norm_name:
            return price
    # 부분 일치
    for cand_name, price in candidates:
        if normalize(cand_name) in norm_name or norm_name in normalize(cand_name):
            return price
    # 매핑 실패 시 None
    return None


# ──────────────────────────────────────────
# 3. 일봉 OHLCV — FinanceDataReader
# ──────────────────────────────────────────

def get_prices(ticker: str, start_date: str) -> list[dict] | None:
    try:
        df = fdr.DataReader(ticker, start=start_date)
        if df is None or df.empty:
            return None
        rows = []
        for dt, r in df.iterrows():
            o = int(r.get("Open", 0) or 0)
            h = int(r.get("High", 0) or 0)
            l = int(r.get("Low", 0) or 0)
            c = int(r.get("Close", 0) or 0)
            # 거래정지·결측일은 OHLC 중 일부가 0으로 들어옴(체결 불가) → 제외.
            # 정상 거래일은 o/h/l/c 모두 양수여야 한다.
            if o <= 0 or h <= 0 or l <= 0 or c <= 0:
                continue
            rows.append({"d": dt.strftime("%Y-%m-%d"), "o": o, "h": h, "l": l, "c": c})
        return rows or None
    except Exception as e:
        print(f"    가격 오류 {ticker}: {e}")
        return None


# ──────────────────────────────────────────
# 4. 메인
# ──────────────────────────────────────────

def main():
    print("=== IPO 데이터 수집 시작 ===")
    print(f"대상 기간: {IPO_START} ~ 오늘\n")

    # ── 상장 목록 ──
    print("[1/3] KIND 상장 목록 조회...")
    listing = get_listing_df()

    # ── 공모가 ──
    print("\n[2/3] 공모가 수집 (finuts.co.kr)...")
    date_map = get_finuts_ipo_prices()

    # 기존 데이터에서 공모가 보존
    existing: dict[str, dict] = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
            for s in old.get("stocks", []):
                existing[s["ticker"]] = s
            prev_with_price = sum(1 for s in old["stocks"] if s.get("ipo_price"))
            print(f"  기존 데이터 {len(existing)}개 (공모가 보유 {prev_with_price}개) 로드")
        except Exception:
            pass

    # ── 일봉 수집 ──
    print(f"\n[3/3] 일봉 OHLCV 수집 ({len(listing)}개 종목)...")
    stocks: list[dict] = []

    for i, row in listing.iterrows():
        ticker   = row["ticker"]
        name     = str(row["name"])
        market   = row["Market"]
        ipo_date = row["ipo_date"].strftime("%Y-%m-%d")

        print(f"  [{i+1}/{len(listing)}] {ticker} {name} ({ipo_date})", end="", flush=True)

        prices = get_prices(ticker, ipo_date)
        if not prices:
            print(" → 데이터 없음, 건너뜀")
            continue

        listing_open = prices[0]["o"]
        ipo_price = (
            match_ipo_price(date_map, ipo_date, name)
            or existing.get(ticker, {}).get("ipo_price")
        )

        stocks.append({
            "ticker":       ticker,
            "name":         name,
            "market":       market,
            "ipo_date":     ipo_date,
            "ipo_price":    ipo_price,
            "listing_open": listing_open,
            "prices":       prices,
        })
        flag = f"공모가 {ipo_price:,}" if ipo_price else "공모가 ?"
        print(f" → {len(prices)}일 / {flag} / 시초가 {listing_open:,}")
        time.sleep(0.2)

    output = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "stocks": stocks,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )

    has_price = sum(1 for s in stocks if s["ipo_price"])
    print(f"\n=== 완료: {len(stocks)}개 종목 (공모가 {has_price}개) → {OUT} ===")


if __name__ == "__main__":
    main()
