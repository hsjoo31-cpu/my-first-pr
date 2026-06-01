#!/usr/bin/env python3
"""IPO 백테스팅 데이터 수집 스크립트

2023-06-26 이후 상장한 KOSPI/KOSDAQ 종목의
공모가, 시초가, 일봉 OHLCV 데이터를 수집하여 docs/data/ipo_data.json 저장.
"""

import json
import time
import requests
import pandas as pd
import FinanceDataReader as fdr
from datetime import datetime
from pathlib import Path

IPO_START = "2023-06-26"
OUT = Path("docs/data/ipo_data.json")

KRX_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
    ),
    "Referer": "https://data.krx.co.kr/",
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
}


# ──────────────────────────────────────────
# 1. 상장 종목 목록
# ──────────────────────────────────────────

def get_listing_df() -> pd.DataFrame:
    kospi = fdr.StockListing("KOSPI")
    kosdaq = fdr.StockListing("KOSDAQ")
    kospi["Market"] = "KOSPI"
    kosdaq["Market"] = "KOSDAQ"
    df = pd.concat([kospi, kosdaq], ignore_index=True)

    # 열 이름 정규화
    date_col = next((c for c in ["ListingDate", "Listing", "IPOdate"] if c in df.columns), None)
    code_col = next((c for c in ["Code", "Symbol"] if c in df.columns), None)
    name_col = next((c for c in ["Name", "ShortName"] if c in df.columns), None)

    if not date_col or not code_col or not name_col:
        raise RuntimeError(f"예상 열 없음. 실제 열: {list(df.columns)}")

    df["_date"] = pd.to_datetime(df[date_col], errors="coerce")
    df["_code"] = df[code_col].astype(str).str.zfill(6)
    df["_name"] = df[name_col].astype(str)

    df = df[df["_date"] >= IPO_START].copy()
    df = df.sort_values("_date").reset_index(drop=True)
    print(f"  상장 목록: {len(df)}개 (KOSPI {(df['Market']=='KOSPI').sum()}, KOSDAQ {(df['Market']=='KOSDAQ').sum()})")
    return df


# ──────────────────────────────────────────
# 2. 공모가 (KRX data portal)
# ──────────────────────────────────────────

def get_krx_ipo_prices() -> dict[str, int]:
    """KRX data.krx.co.kr에서 공모가(OFFERING_PRC) 일괄 수집."""
    url = "https://data.krx.co.kr/comm/bldAttendant/getJsonData.cmd"
    payload = {
        "bld": "dbms/MDC/STAT/srt/MDCSTAT04901",
        "locale": "ko_KR",
        "isuCd": "",
        "strtDd": IPO_START.replace("-", ""),
        "endDd": datetime.now().strftime("%Y%m%d"),
        "share": "1",
        "money": "1",
        "csvxls_isNo": "false",
    }

    ipo_prices: dict[str, int] = {}
    try:
        resp = requests.post(url, data=payload, headers=KRX_HEADERS, timeout=20)
        resp.raise_for_status()
        items = resp.json().get("output", [])
        for item in items:
            # KRX 응답 필드명이 버전마다 다를 수 있어 후보를 모두 시도
            code = (
                item.get("ISU_SRT_CD") or item.get("단축코드") or ""
            ).strip().zfill(6)
            raw = (
                item.get("OFFERING_PRC")
                or item.get("공모가격")
                or item.get("공모가")
                or "0"
            )
            try:
                price = int(str(raw).replace(",", ""))
            except ValueError:
                price = 0
            if code and price:
                ipo_prices[code] = price
        print(f"  KRX 공모가: {len(ipo_prices)}개 수집")
    except Exception as e:
        print(f"  KRX 공모가 수집 실패 (비어있는 ipo_price로 진행): {e}")

    return ipo_prices


# ──────────────────────────────────────────
# 3. 일봉 OHLCV
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
            if o == 0 and h == 0 and l == 0 and c == 0:
                continue
            rows.append({"d": dt.strftime("%Y-%m-%d"), "o": o, "h": h, "l": l, "c": c})
        return rows if rows else None
    except Exception as e:
        print(f"    가격 오류 {ticker}: {e}")
        return None


# ──────────────────────────────────────────
# 4. 메인
# ──────────────────────────────────────────

def main():
    print("=== IPO 데이터 수집 시작 ===")
    print(f"대상 기간: {IPO_START} ~ 오늘")

    print("\n[1/3] 상장 목록 조회...")
    listing = get_listing_df()

    print("\n[2/3] KRX 공모가 조회...")
    ipo_prices = get_krx_ipo_prices()

    # 기존 데이터 로드 (공모가 보존용 증분 업데이트)
    existing: dict[str, dict] = {}
    if OUT.exists():
        try:
            old = json.loads(OUT.read_text(encoding="utf-8"))
            for s in old.get("stocks", []):
                existing[s["ticker"]] = s
            print(f"  기존 데이터: {len(existing)}개 종목 보존")
        except Exception:
            pass

    print(f"\n[3/3] 일봉 데이터 수집 ({len(listing)}개 종목)...")
    stocks: list[dict] = []

    for i, row in listing.iterrows():
        ticker = row["_code"]
        name = row["_name"]
        market = row["Market"]
        ipo_date = row["_date"].strftime("%Y-%m-%d")

        print(f"  [{i+1}/{len(listing)}] {ticker} {name} ({ipo_date})", end="", flush=True)

        prices = get_prices(ticker, ipo_date)
        if not prices:
            print(" → 데이터 없음, 건너뜀")
            continue

        listing_open = prices[0]["o"]

        # 공모가: KRX API → 기존 저장값 순으로 우선
        ipo_price = ipo_prices.get(ticker) or existing.get(ticker, {}).get("ipo_price")

        stocks.append({
            "ticker": ticker,
            "name": name,
            "market": market,
            "ipo_date": ipo_date,
            "ipo_price": ipo_price,        # None이면 프론트에서 시초가 탭만 활성화
            "listing_open": listing_open,
            "prices": prices,
        })
        print(f" → {len(prices)}일 / 공모가 {ipo_price or '?'} / 시초가 {listing_open}")
        time.sleep(0.25)

    output = {
        "updated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "stocks": stocks,
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(
        json.dumps(output, ensure_ascii=False, separators=(",", ":")),
        encoding="utf-8",
    )
    print(f"\n=== 완료: {len(stocks)}개 종목 → {OUT} ===")


if __name__ == "__main__":
    main()
