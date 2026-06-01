#!/usr/bin/env python3
"""IPO 백테스팅 데이터 수집 스크립트

1. KIND(KRX 공시) → 2023-06-26 이후 상장 종목 목록 + 상장일
2. ipostock.co.kr  → 공모가 (베스트 에포트; 실패해도 None으로 처리)
3. FinanceDataReader → 일봉 OHLCV
결과: docs/data/ipo_data.json
"""

import io, json, time, re, requests
import pandas as pd
import FinanceDataReader as fdr
from datetime import datetime
from pathlib import Path
from bs4 import BeautifulSoup

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
    resp = requests.get(url, params=params, headers=HEADERS, timeout=20)
    df = pd.read_html(io.StringIO(resp.content.decode("euc-kr")))[0]
    df["Market"] = market_label
    return df


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
    df = df.sort_values("ipo_date").reset_index(drop=True)
    print(f"  KIND 상장 목록: {len(df)}개 "
          f"(KOSPI {(df['Market']=='KOSPI').sum()}, "
          f"KOSDAQ {(df['Market']=='KOSDAQ').sum()})")
    return df


# ──────────────────────────────────────────
# 2. 공모가 — ipostock.co.kr 스크래핑
# ──────────────────────────────────────────

def scrape_ipo_prices_ipostock(tickers: list[str]) -> dict[str, int]:
    """
    ipostock.co.kr의 종목별 페이지에서 공모가를 수집한다.
    실패해도 빈 dict 반환 — 공모가 없으면 프론트에서 시초가 탭만 활성화.
    """
    prices: dict[str, int] = {}
    for ticker in tickers:
        try:
            url = f"https://ipostock.co.kr/view/ipo_cpninfo.asp?code={ticker}"
            resp = requests.get(url, headers=HEADERS, timeout=10)
            html = resp.content.decode("euc-kr", errors="replace")

            # "확정공모가" 또는 "공모가" 뒤의 숫자 패턴
            m = re.search(r"확정\s*공모가[^\d]{0,20}([\d,]+)\s*원", html)
            if not m:
                m = re.search(r"공모가[^\d]{0,20}([\d,]+)\s*원", html)
            if m:
                prices[ticker] = int(m.group(1).replace(",", ""))
        except Exception:
            pass
        time.sleep(0.15)
    print(f"  ipostock 공모가: {len(prices)}/{len(tickers)}개 수집")
    return prices


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
            if o == 0 and c == 0:
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
    print("\n[2/3] 공모가 수집 (ipostock.co.kr)...")
    tickers_list = listing["ticker"].tolist()
    ipo_prices = scrape_ipo_prices_ipostock(tickers_list)

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
            ipo_prices.get(ticker)
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
