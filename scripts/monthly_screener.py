"""
월간 자동 모멘텀 스크리너 (GitHub Actions에서 실행)

기준:
1. KOSPI + KOSDAQ 시총 3000억 이상
2. 직전 1개월 주가상승률 상위 100개
3. 네이버 금융 리포트 3개월 내 2건 이상

결과는 docs/data/results.json 으로 저장됨
"""

import os
import sys
import json
import time
import warnings
import pandas as pd
import requests
import yfinance as yf
import FinanceDataReader as fdr
from bs4 import BeautifulSoup
from datetime import datetime, timedelta, timezone

warnings.filterwarnings("ignore")

# ── 설정 ─────────────────────────────────────────────────
MARKET_CAP_MIN = 300_000_000_000
TOP_N = 100
REPORT_MIN = 2
REPORT_WINDOW_DAYS = 91
LOOKBACK_DAYS = 30  # 1개월
YF_BATCH = 100
NAVER_DELAY = 0.15
OUTPUT_PATH = os.path.join("docs", "data", "results.json")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}
KST = timezone(timedelta(hours=9))


def yf_suffix(market_id: str) -> str:
    return ".KS" if market_id == "STK" else ".KQ"


def fetch_close_panel(yf_tickers, start, end):
    panels = []
    n_batches = (len(yf_tickers) - 1) // YF_BATCH + 1
    for i in range(0, len(yf_tickers), YF_BATCH):
        batch = yf_tickers[i:i + YF_BATCH]
        try:
            data = yf.download(
                batch, start=start, end=end,
                progress=False, auto_adjust=True, threads=True,
                group_by="ticker",
            )
            if "Close" in data.columns.get_level_values(0):
                close = data["Close"]
            else:
                close = data.xs("Close", level=1, axis=1)
            panels.append(close)
            print(f"  batch {i // YF_BATCH + 1}/{n_batches}", flush=True)
        except Exception as e:
            print(f"  batch {i // YF_BATCH + 1} failed: {e}", flush=True)
    return pd.concat(panels, axis=1) if panels else pd.DataFrame()


def get_report_count(ticker: str, cutoff: datetime) -> int:
    url = (
        "https://finance.naver.com/research/company_list.nhn"
        f"?searchType=itemCode&itemCode={ticker}"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        resp.encoding = "euc-kr"
        soup = BeautifulSoup(resp.text, "html.parser")
        count = 0
        for td in soup.select("td.date"):
            try:
                report_date = datetime.strptime(td.text.strip(), "%y.%m.%d")
                if report_date >= cutoff:
                    count += 1
            except ValueError:
                continue
        return count
    except Exception:
        return 0


def main():
    now = datetime.now(KST)
    print(f"실행 시각: {now.isoformat()}", flush=True)

    # [1] Universe
    print("[1/4] universe 구성...", flush=True)
    listing = fdr.StockListing("KRX")
    listing = listing[listing["MarketId"].isin(["STK", "KSQ"])]
    universe = listing[listing["Marcap"] >= MARKET_CAP_MIN].copy()
    universe["yf_ticker"] = universe["Code"] + universe["MarketId"].apply(yf_suffix)
    print(f"  → {len(universe)}개", flush=True)

    # [2] 1개월 수익률
    print("[2/4] 1개월 수익률 계산...", flush=True)
    end_target = now
    start_target = end_target - timedelta(days=LOOKBACK_DAYS + 14)
    prices = fetch_close_panel(
        universe["yf_ticker"].tolist(),
        start_target.strftime("%Y-%m-%d"),
        (end_target + timedelta(days=1)).strftime("%Y-%m-%d"),
    )
    prices.columns = [c.split(".")[0] for c in prices.columns]
    prices = prices.dropna(how="all").ffill(limit=5)

    if prices.empty:
        raise RuntimeError("가격 데이터 없음")

    latest_dt = prices.index[-1]
    target_start = latest_dt - timedelta(days=LOOKBACK_DAYS)
    start_idx = prices.index.searchsorted(target_start)
    start_dt = prices.index[start_idx]
    report_cutoff = latest_dt - timedelta(days=REPORT_WINDOW_DAYS)

    print(f"  → 기간: {start_dt.date()} ~ {latest_dt.date()}", flush=True)

    returns = (prices.loc[latest_dt] / prices.loc[start_dt] - 1) * 100
    returns = returns.dropna()

    df = (
        universe[["Code", "Name", "Marcap", "Market"]]
        .assign(Return=universe["Code"].map(returns))
        .dropna(subset=["Return"])
        .sort_values("Return", ascending=False)
        .head(TOP_N)
        .reset_index(drop=True)
    )
    print(f"  → 상위 {len(df)}개 후보", flush=True)

    # [3] 네이버 리포트 필터
    print("[3/4] 네이버 리포트 크롤링...", flush=True)
    passed = []
    for _, row in df.iterrows():
        count = get_report_count(row["Code"], report_cutoff)
        if count >= REPORT_MIN:
            passed.append({
                "rank": len(passed) + 1,
                "ticker": row["Code"],
                "name": row["Name"],
                "market": row["Market"],
                "return_pct": round(float(row["Return"]), 2),
                "marcap_eok": round(float(row["Marcap"]) / 1e8),
                "report_count": count,
            })
        time.sleep(NAVER_DELAY)
    print(f"  → 통과: {len(passed)}개", flush=True)

    # [4] JSON 저장
    print("[4/4] 결과 저장...", flush=True)
    result = {
        "updated_at": now.isoformat(),
        "period": {
            "start": start_dt.strftime("%Y-%m-%d"),
            "end": latest_dt.strftime("%Y-%m-%d"),
        },
        "criteria": {
            "market_cap_min_eok": MARKET_CAP_MIN // 100_000_000,
            "top_n_candidates": TOP_N,
            "report_window_days": REPORT_WINDOW_DAYS,
            "report_min": REPORT_MIN,
        },
        "universe_size": int(len(universe)),
        "passed_count": len(passed),
        "stocks": passed,
    }
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, indent=2)
    print(f"저장 완료 → {OUTPUT_PATH}", flush=True)


if __name__ == "__main__":
    main()
