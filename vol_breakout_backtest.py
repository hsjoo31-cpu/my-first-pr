"""
Bitcoin 선물 변동성 돌파(Volatility Breakout) 백테스트
- 거래소: Binance USDT-M 선물 (ccxt)
- 분봉 기준 (기본 5m)
- 신호: 각 봉의 목표가 = 시가 + k × (직전 봉 고가 - 저가)
        봉 진행 중 고가가 목표가를 넘으면 그 가격에 롱 진입, 봉 마감에 청산
- k = 0.3, 0.5, 0.7, 1.0 비교
- 수수료 + 슬리피지 반영. (선택) 이동평균 추세 필터

⚠️ 레버리지 선물은 청산 위험이 큽니다. 본 코드는 학습/검증용 백테스트이며,
   실거래 전 반드시 테스트넷에서 충분히 검증하세요.
"""

import os
import time
import warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

# ── 설정 ─────────────────────────────────────────────────
SYMBOL = "BTC/USDT"
TIMEFRAME = "5m"           # 분봉: 1m, 3m, 5m, 15m ...
LOOKBACK_DAYS = 90         # 받아올 과거 기간
K_VALUES = [0.3, 0.5, 0.7, 1.0]
TAKER_FEE = 0.0004         # 바이낸스 선물 taker 0.04% (편도)
SLIPPAGE = 0.0002          # 슬리피지 가정 (편도)
MA_FILTER = 0              # 0이면 미사용. N>0이면 직전 종가 > N봉 이평일 때만 진입
LEVERAGE = 1               # 백테스트 표시용 (수익률 배수). 청산은 별도 고려 필요

CACHE_FILE = f"vb_{SYMBOL.replace('/', '')}_{TIMEFRAME}.parquet"


def fetch_ohlcv_paged(symbol, timeframe, days):
    """ccxt로 OHLCV를 페이지네이션하며 days일치 수집."""
    import ccxt
    ex = ccxt.binanceusdm({"enableRateLimit": True})
    tf_ms = ex.parse_timeframe(timeframe) * 1000
    since = ex.milliseconds() - days * 24 * 60 * 60 * 1000
    rows = []
    while True:
        batch = ex.fetch_ohlcv(symbol, timeframe, since=since, limit=1000)
        if not batch:
            break
        rows += batch
        since = batch[-1][0] + tf_ms
        print(f"  수집 {len(rows)}봉 (최근 {pd.to_datetime(batch[-1][0], unit='ms')})")
        if len(batch) < 1000:
            break
        time.sleep(ex.rateLimit / 1000)
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df = df.drop_duplicates("ts").set_index(pd.to_datetime(df["ts"], unit="ms"))
    return df[["open", "high", "low", "close", "volume"]]


def load_data():
    if os.path.exists(CACHE_FILE):
        df = pd.read_parquet(CACHE_FILE)
        print(f"  → 캐시 사용: {len(df)}봉\n")
        return df
    print(f"  → 바이낸스에서 {SYMBOL} {TIMEFRAME} 수집...")
    df = fetch_ohlcv_paged(SYMBOL, TIMEFRAME, LOOKBACK_DAYS)
    df.to_parquet(CACHE_FILE)
    print(f"  → {len(df)}봉 수집 (캐시 저장)\n")
    return df


def backtest_k(df, k):
    """변동성 돌파 백테스트. 봉별 수익률 시리즈(수수료 차감) 반환."""
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    prev_range = (h.shift(1) - l.shift(1))
    target = o + k * prev_range

    entered = h >= target              # 봉 내 고가가 목표가 돌파 → 진입 가정
    if MA_FILTER > 0:
        ma = c.rolling(MA_FILTER).mean()
        entered &= c.shift(1) > ma.shift(1)

    # 진입가 = target, 청산가 = 종가. 미진입 봉은 수익률 0.
    gross = np.where(entered, c / target - 1.0, 0.0)
    cost = np.where(entered, 2 * (TAKER_FEE + SLIPPAGE), 0.0)  # 진입+청산 왕복
    ret = (gross - cost) * LEVERAGE
    ret = pd.Series(ret, index=df.index).fillna(0.0)
    return ret


def perf_stats(ret: pd.Series, periods_per_year: float) -> dict:
    equity = (1 + ret).cumprod()
    n_years = len(ret) / periods_per_year
    cagr = equity.iloc[-1] ** (1 / n_years) - 1 if n_years > 0 else 0
    sharpe = (ret.mean() / ret.std() * np.sqrt(periods_per_year)
              if ret.std() > 0 else 0)
    cummax = equity.cummax()
    mdd = (equity / cummax - 1).min()
    trades = ret[ret != 0]
    win_rate = (trades > 0).mean() if len(trades) else 0
    return {
        "총수익률(%)": round((equity.iloc[-1] - 1) * 100, 2),
        "CAGR(%)": round(cagr * 100, 2),
        "Sharpe": round(sharpe, 2),
        "MDD(%)": round(mdd * 100, 2),
        "진입횟수": int(len(trades)),
        "승률(%)": round(win_rate * 100, 1),
    }


def main():
    print("[1/3] 데이터 로드...")
    df = load_data()

    # 연환산 계수 (타임프레임 기준)
    tf_min = {"1m": 1, "3m": 3, "5m": 5, "15m": 15, "30m": 30, "1h": 60}[TIMEFRAME]
    periods_per_year = 365 * 24 * 60 / tf_min

    print("[2/3] k값별 백테스트...")
    curves, stats = {}, {}
    for k in K_VALUES:
        ret = backtest_k(df, k)
        curves[k] = (1 + ret).cumprod()
        stats[k] = perf_stats(ret, periods_per_year)

    # Buy & Hold 비교
    bh_ret = df["close"].pct_change().fillna(0)
    stats["B&H"] = perf_stats(bh_ret, periods_per_year)

    print("[3/3] 결과 집계...\n")
    summary = pd.DataFrame(stats).T
    summary.index.name = "전략(k)"
    period = f"{df.index[0].date()} ~ {df.index[-1].date()}"
    print("=" * 72)
    print(f"심볼: {SYMBOL} 선물 / 봉: {TIMEFRAME} / 기간: {period}")
    print(f"수수료 {TAKER_FEE*100:.3f}% + 슬리피지 {SLIPPAGE*100:.3f}% (편도) / "
          f"레버리지 {LEVERAGE}x / MA필터 {MA_FILTER or '없음'}")
    print("=" * 72)
    print(summary.to_string())
    print()

    summary.to_csv("vol_breakout_summary.csv", encoding="utf-8-sig")
    eq_df = pd.DataFrame({f"k={k}": eq for k, eq in curves.items()})
    eq_df.to_csv("vol_breakout_equity.csv", encoding="utf-8-sig")
    print("저장 완료: vol_breakout_summary.csv, vol_breakout_equity.csv")


if __name__ == "__main__":
    main()
