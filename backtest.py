"""
Korean stock momentum backtest
- 시총 3000억 이상 (현재 기준 → 생존편향 있음)
- 매월 말 리밸런싱
- 3개월 수익률 (직전 1주 제외)으로 상위 N개 동일가중 매수
- Top N = 5, 10, 20, 30, 50, 100 비교
"""

import os
import warnings
import numpy as np
import pandas as pd
import yfinance as yf
import FinanceDataReader as fdr
from datetime import datetime, timedelta

CACHE_PRICES = "backtest_prices_cache.parquet"
CACHE_BENCH = "backtest_bench_cache.parquet"

warnings.filterwarnings("ignore")

# ── 설정 ─────────────────────────────────────────────────
START_DATE = "2020-01-01"
END_DATE = datetime.today().strftime("%Y-%m-%d")
MARKET_CAP_MIN = 300_000_000_000
TOP_N_VALUES = [5, 10, 20, 30, 50, 100]
LOOKBACK_DAYS = 91     # 약 3개월
SKIP_DAYS = 5          # 약 1주 (거래일)
COMMISSION = 0.003     # 왕복 30bp
YF_BATCH = 100
BENCHMARK_YF = "069500.KS"   # KODEX 200


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
            print(f"  배치 {i // YF_BATCH + 1}/{n_batches} 완료")
        except Exception as e:
            print(f"  배치 {i // YF_BATCH + 1} 실패: {e}")
    return pd.concat(panels, axis=1) if panels else pd.DataFrame()


def perf_stats(equity: pd.Series) -> dict:
    years = (equity.index[-1] - equity.index[0]).days / 365.25
    cagr = (equity.iloc[-1] / equity.iloc[0]) ** (1 / years) - 1
    monthly_ret = equity.pct_change().dropna()
    sharpe = (monthly_ret.mean() / monthly_ret.std() * np.sqrt(12)
              if monthly_ret.std() > 0 else 0)
    cummax = equity.cummax()
    mdd = (equity / cummax - 1).min()
    win_rate = (monthly_ret > 0).mean()
    return {
        "CAGR(%)": round(cagr * 100, 2),
        "총수익률(%)": round((equity.iloc[-1] / equity.iloc[0] - 1) * 100, 2),
        "Sharpe": round(sharpe, 2),
        "MDD(%)": round(mdd * 100, 2),
        "월승률(%)": round(win_rate * 100, 1),
    }


def main():
    print("[1/5] 종목 유니버스 구성...")
    listing = fdr.StockListing("KRX")
    listing = listing[listing["MarketId"].isin(["STK", "KSQ"])]
    universe = listing[listing["Marcap"] >= MARKET_CAP_MIN].copy()
    universe["yf_ticker"] = universe["Code"] + universe["MarketId"].apply(yf_suffix)
    print(f"  → {len(universe)}개 종목\n")

    print(f"[2/5] 가격 데이터 ({START_DATE} ~ {END_DATE})...")
    if os.path.exists(CACHE_PRICES):
        prices = pd.read_parquet(CACHE_PRICES)
        print(f"  → 캐시 사용: {prices.shape[0]}일 × {prices.shape[1]}종목\n")
    else:
        prices = fetch_close_panel(universe["yf_ticker"].tolist(), START_DATE, END_DATE)
        prices.columns = [c.split(".")[0] for c in prices.columns]
        prices = prices.loc[:, ~prices.columns.duplicated()]
        prices = prices.dropna(how="all").ffill(limit=5)
        prices.to_parquet(CACHE_PRICES)
        print(f"  → 가격패널: {prices.shape[0]}일 × {prices.shape[1]}종목 (캐시 저장)\n")

    print("[3/5] 벤치마크(KODEX 200)...")
    if os.path.exists(CACHE_BENCH):
        bench = pd.read_parquet(CACHE_BENCH).iloc[:, 0]
        print(f"  → 캐시 사용: {len(bench)}일\n")
    else:
        bench_raw = yf.download(BENCHMARK_YF, start=START_DATE, end=END_DATE,
                                progress=False, auto_adjust=True)
        bench = bench_raw["Close"].squeeze().dropna()
        bench.to_frame("Close").to_parquet(CACHE_BENCH)
        print(f"  → 벤치마크: {len(bench)}일 (캐시 저장)\n")

    print("[4/5] 월간 리밸런싱 백테스트...")
    # 각 월의 실제 마지막 거래일
    idx_df = pd.DataFrame({"date": prices.index}, index=prices.index)
    idx_df["ym"] = idx_df.index.to_period("M")
    month_ends = pd.DatetimeIndex(
        idx_df.groupby("ym")["date"].last().values
    ).sort_values()
    print(f"  → 리밸런싱 횟수: {len(month_ends) - 1}회\n")

    # 각 리밸런싱 날짜의 모멘텀 신호 미리 계산
    signals = {}
    for d in month_ends:
        end_idx = prices.index.searchsorted(d) - SKIP_DAYS
        if end_idx < 1:
            continue
        end_d = prices.index[end_idx]
        start_target = end_d - timedelta(days=LOOKBACK_DAYS)
        start_idx = prices.index.searchsorted(start_target)
        if start_idx >= end_idx:
            continue
        start_d = prices.index[start_idx]
        ret = (prices.loc[end_d] / prices.loc[start_d] - 1).dropna()
        signals[d] = ret

    # 각 Top-N에 대해 백테스트
    equity_curves = {}
    for n in TOP_N_VALUES:
        values = [1.0]
        dates = [month_ends[0]]
        for i in range(len(month_ends) - 1):
            d, nd = month_ends[i], month_ends[i + 1]
            if d not in signals:
                values.append(values[-1])
                dates.append(nd)
                continue
            top = signals[d].nlargest(n).index
            # 보유 기간 수익률
            start_px = prices.loc[d, top].dropna()
            end_px = prices.loc[nd, top].reindex(start_px.index).dropna()
            common = start_px.index.intersection(end_px.index)
            if len(common) == 0:
                values.append(values[-1])
                dates.append(nd)
                continue
            period_ret = (end_px[common] / start_px[common] - 1).mean()
            period_ret -= COMMISSION
            values.append(values[-1] * (1 + period_ret))
            dates.append(nd)
        equity_curves[n] = pd.Series(values, index=pd.DatetimeIndex(dates))

    # 벤치마크 곡선 (월말)
    bench_monthly = bench.reindex(month_ends, method="ffill").dropna()
    bench_eq = bench_monthly / bench_monthly.iloc[0]

    print("[5/5] 결과 집계 및 저장...\n")
    # 통계 테이블
    summary = pd.DataFrame({n: perf_stats(eq) for n, eq in equity_curves.items()}).T
    summary.index.name = "Top N"
    summary.loc["KODEX 200"] = perf_stats(bench_eq)

    # 출력
    print("=" * 70)
    print(f"백테스트 기간: {month_ends[0].date()} ~ {month_ends[-1].date()} "
          f"({(month_ends[-1] - month_ends[0]).days / 365.25:.1f}년)")
    print(f"리밸런싱: 월간 / 거래비용: {COMMISSION * 100:.1f}% (왕복)")
    print(f"신호: 3개월 수익률 (직전 {SKIP_DAYS}거래일 제외) / 동일가중")
    print("=" * 70)
    print(summary.to_string())
    print()

    # 최고 N
    best_n = summary.drop("KODEX 200")["CAGR(%)"].idxmax()
    print(f"★ 최고 CAGR: Top {best_n} → {summary.loc[best_n, 'CAGR(%)']}%")
    print()

    # CSV 저장
    eq_df = pd.DataFrame({f"Top{n}": eq for n, eq in equity_curves.items()})
    eq_df["KODEX200"] = bench_eq
    eq_df.to_csv("backtest_equity.csv", encoding="utf-8-sig")
    summary.to_csv("backtest_summary.csv", encoding="utf-8-sig")
    print("저장 완료: backtest_equity.csv, backtest_summary.csv")


if __name__ == "__main__":
    main()
