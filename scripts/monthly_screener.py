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
YF_BATCH = 100
NAVER_DELAY = 0.15
OUTPUT_PATH = os.path.join("docs", "data", "results.json")
HISTORY_PATH = os.path.join("docs", "data", "history.json")

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

    # [2] 월봉 종가 기준 수익률 (직전 월말 종가 → 측정 월말 종가)
    print("[2/4] 월봉 수익률 계산...", flush=True)
    this_month_first = now.replace(day=1, hour=0, minute=0, second=0, microsecond=0)
    prev_month_last = this_month_first - timedelta(days=1)
    prev_month_first = prev_month_last.replace(day=1)
    target_month_str = prev_month_first.strftime("%Y-%m")

    # 측정 월의 직전 월 말일 종가가 필요 → 넉넉히 10일 더 받음
    fetch_start = (prev_month_first - timedelta(days=10)).strftime("%Y-%m-%d")
    fetch_end = this_month_first.strftime("%Y-%m-%d")

    prices = fetch_close_panel(
        universe["yf_ticker"].tolist(), fetch_start, fetch_end,
    )
    prices.columns = [c.split(".")[0] for c in prices.columns]
    prices = prices.dropna(how="all").ffill(limit=5)

    if prices.empty:
        raise RuntimeError("가격 데이터 없음")

    pmf_naive = prev_month_first.replace(tzinfo=None)
    tmf_naive = this_month_first.replace(tzinfo=None)

    # 측정 월에 속한 거래일
    month_mask = (prices.index >= pmf_naive) & (prices.index < tmf_naive)
    prices_month = prices.loc[month_mask]
    if prices_month.empty:
        raise RuntimeError(f"{target_month_str} 거래일 데이터 없음")
    end_dt = prices_month.index[-1]  # 측정 월의 마지막 거래일

    # 직전 월의 마지막 거래일 (측정 월 첫째 날 이전 가장 가까운 거래일)
    prior = prices.loc[prices.index < pmf_naive]
    if prior.empty:
        raise RuntimeError(f"{target_month_str} 직전 월말 종가 데이터 없음")
    start_dt = prior.index[-1]

    report_cutoff = end_dt - timedelta(days=REPORT_WINDOW_DAYS)

    print(f"  → 측정 월: {target_month_str}", flush=True)
    print(f"  → 월봉 종가 기준: {start_dt.date()} → {end_dt.date()}", flush=True)

    returns = (prices.loc[end_dt] / prices.loc[start_dt] - 1) * 100
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
        "target_month": target_month_str,
        "period": {
            "start": start_dt.strftime("%Y-%m-%d"),
            "end": end_dt.strftime("%Y-%m-%d"),
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

    # 히스토리 누적
    history = []
    if os.path.exists(HISTORY_PATH):
        try:
            with open(HISTORY_PATH, "r", encoding="utf-8") as f:
                history = json.load(f)
        except Exception:
            history = []

    # 직전 월 항목에 "다음 달 평균 수익률" 백필
    # 현재 run의 start_dt(직전 월말) → end_dt(측정 월말)이므로
    # 정확히 직전 항목의 forward return을 채울 수 있다
    backfill_target = (prev_month_first - timedelta(days=1)).replace(day=1).strftime("%Y-%m")
    for h in history:
        if h.get("target_month") != backfill_target:
            continue
        rets10, rets20 = [], []
        for idx, s in enumerate(h.get("stocks", [])[:20]):
            ticker = s.get("ticker")
            if ticker not in prices.columns:
                continue
            try:
                px_a = prices.at[start_dt, ticker]
                px_b = prices.at[end_dt, ticker]
            except KeyError:
                continue
            if pd.isna(px_a) or pd.isna(px_b) or px_a <= 0:
                continue
            r = (px_b / px_a - 1) * 100
            if idx < 10:
                rets10.append(r)
            rets20.append(r)
        if rets10 or rets20:
            h["forward_returns"] = {
                "next_month": target_month_str,
                "next_period": {
                    "start": start_dt.strftime("%Y-%m-%d"),
                    "end": end_dt.strftime("%Y-%m-%d"),
                },
                "top10_avg_pct": round(sum(rets10) / len(rets10), 2) if rets10 else None,
                "top20_avg_pct": round(sum(rets20) / len(rets20), 2) if rets20 else None,
                "top10_n": len(rets10),
                "top20_n": len(rets20),
            }
            print(f"  → {backfill_target} forward returns 백필: "
                  f"top10={h['forward_returns']['top10_avg_pct']}% / "
                  f"top20={h['forward_returns']['top20_avg_pct']}%", flush=True)
        break

    history = [h for h in history if h.get("target_month") != target_month_str]
    history.append({
        "target_month": target_month_str,
        "updated_at": now.isoformat(),
        "period": result["period"],
        "passed_count": len(passed),
        "stocks": passed,
    })
    history.sort(key=lambda h: h["target_month"], reverse=True)
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(history, f, ensure_ascii=False, indent=2)
    print(f"히스토리 누적 → {HISTORY_PATH} ({len(history)}개월)", flush=True)


if __name__ == "__main__":
    main()
