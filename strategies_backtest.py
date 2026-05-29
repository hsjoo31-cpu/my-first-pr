"""
Bitcoin 선물 멀티 전략 백테스트 (롱/숏 양방향)
- 거래소: Binance USDT-M 선물 (ccxt) — 5m 봉을 받아 15m/1h/4h로 리샘플링
- 전략 4종을 동일한 비용/사이징 엔진으로 비교
    A) EMA 추세추종    (15m, 1h 추세 필터)
    B) 변동성 돌파     (5m,  15m 추세 필터)
    C) RSI+볼린저 평균회귀 (5m, 1h 레짐 필터)
    D) 멀티타임프레임 정렬 (15m 진입, 1h/4h 정렬)
- 비용: taker 수수료 + 슬리피지 (편도), 보유 시 펀딩비 근사 반영
- 포지션 사이징: 거래당 자본의 risk%를 손절폭에 맞춰 베팅 (fixed-fractional),
                레버리지 상한 적용. 손절/익절은 봉 내 고저로 체결 가정.
- 출력: 전략별 총수익/CAGR/Sharpe/MDD/거래수/승률/손익비/월·연 거래수

⚠️ 레버리지 선물은 청산 위험이 큽니다. 학습/검증용이며 실거래 전 테스트넷 필수.
   데이터 수집에는 바이낸스 API 접속이 필요합니다(차단 환경에서는 동작 안 함).
"""

import os
import time
import warnings
import numpy as np
import pandas as pd

warnings.filterwarnings("ignore")

# ── 공통 설정 ────────────────────────────────────────────
SYMBOL = "BTC/USDT"
BASE_TF = "5m"
LOOKBACK_DAYS = 180
TAKER_FEE = 0.0004        # 0.04% 편도
SLIPPAGE = 0.0002         # 0.02% 편도
FUNDING_PER_8H = 0.0001   # 펀딩비 근사 (8시간당 0.01%, 보유 시간 비례 차감)
INIT_EQUITY = 10_000.0
CACHE_FILE = f"ms_{SYMBOL.replace('/', '')}_{BASE_TF}.parquet"

ROUND_TRIP_COST = 2 * (TAKER_FEE + SLIPPAGE)  # 진입+청산 (notional 대비)


# ── 데이터 ───────────────────────────────────────────────
def fetch_ohlcv_paged(symbol, timeframe, days):
    import ccxt
    ex = ccxt.binanceusdm({"enableRateLimit": True})
    tf_ms = ex.parse_timeframe(timeframe) * 1000
    since = ex.milliseconds() - days * 86_400_000
    rows = []
    while True:
        batch = ex.fetch_ohlcv(symbol, timeframe, since=since, limit=1000)
        if not batch:
            break
        rows += batch
        since = batch[-1][0] + tf_ms
        if len(batch) < 1000:
            break
        time.sleep(ex.rateLimit / 1000)
    df = pd.DataFrame(rows, columns=["ts", "open", "high", "low", "close", "volume"])
    df = df.drop_duplicates("ts").set_index(pd.to_datetime(df["ts"], unit="ms"))
    return df[["open", "high", "low", "close", "volume"]]


def load_data():
    if os.path.exists(CACHE_FILE):
        df = pd.read_parquet(CACHE_FILE)
        print(f"  → 캐시 사용: {len(df)}봉 ({df.index[0].date()}~{df.index[-1].date()})\n")
        return df
    print(f"  → 바이낸스에서 {SYMBOL} {BASE_TF} {LOOKBACK_DAYS}일 수집...")
    df = fetch_ohlcv_paged(SYMBOL, BASE_TF, LOOKBACK_DAYS)
    df.to_parquet(CACHE_FILE)
    print(f"  → {len(df)}봉 수집 (캐시 저장)\n")
    return df


def resample(df, rule):
    o = df["open"].resample(rule).first()
    h = df["high"].resample(rule).max()
    l = df["low"].resample(rule).min()
    c = df["close"].resample(rule).last()
    v = df["volume"].resample(rule).sum()
    return pd.DataFrame({"open": o, "high": h, "low": l, "close": c, "volume": v}).dropna()


# ── 지표 ─────────────────────────────────────────────────
def ema(s, n):
    return s.ewm(span=n, adjust=False).mean()


def rsi(s, n=14):
    d = s.diff()
    up = d.clip(lower=0).ewm(alpha=1 / n, adjust=False).mean()
    dn = (-d.clip(upper=0)).ewm(alpha=1 / n, adjust=False).mean()
    rs = up / dn.replace(0, np.nan)
    return (100 - 100 / (1 + rs)).fillna(50)


def atr(df, n=14):
    h, l, c = df["high"], df["low"], df["close"]
    tr = pd.concat([h - l, (h - c.shift()).abs(), (l - c.shift()).abs()], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / n, adjust=False).mean()


def align(higher: pd.Series, base_index) -> pd.Series:
    """상위 타임프레임 시리즈를 base 인덱스에 미래참조 없이 정렬 (직전 확정값)."""
    return higher.shift(1).reindex(base_index, method="ffill")


# ── 신호 생성 ────────────────────────────────────────────
# 각 함수는 base(5m) 인덱스에 정렬된 dict 반환:
#   dir   : +1 롱 / -1 숏 / 0 무진입 (해당 봉 종가 확정 시점 신호)
#   atr   : 손절폭 산정용 ATR (base 기준)
def sig_A_trend(df5, df15, df1h):
    a = align(ema(df15["close"], 20) - ema(df15["close"], 50), df5.index)
    h1 = align(ema(df1h["close"], 50), df5.index)
    px = df5["close"]
    long = (a > 0) & (px > h1)
    short = (a < 0) & (px < h1)
    d = pd.Series(0, index=df5.index)
    d[long] = 1
    d[short] = -1
    a_atr = align(atr(df15), df5.index)
    return {"dir": d, "atr": a_atr, "rr": 2.0, "lev": 3, "risk": 0.010, "name": "A_추세추종(15m/1h)"}


def sig_B_breakout(df5, df15, df1h):
    k = 0.5
    rng = (df5["high"].shift(1) - df5["low"].shift(1))
    up = df5["open"] + k * rng
    dn = df5["open"] - k * rng
    t15 = align(ema(df15["close"], 50), df5.index)
    long = (df5["high"] >= up) & (df5["close"] > t15)
    short = (df5["low"] <= dn) & (df5["close"] < t15)
    d = pd.Series(0, index=df5.index)
    d[long] = 1
    d[short] = -1
    return {"dir": d, "atr": atr(df5), "rr": 1.5, "lev": 3, "risk": 0.0075, "name": "B_변동성돌파(5m/15m)"}


def sig_C_meanrev(df5, df15, df1h):
    r = rsi(df5["close"], 14)
    mid = df5["close"].rolling(20).mean()
    sd = df5["close"].rolling(20).std()
    upper, lower = mid + 2 * sd, mid - 2 * sd
    # 1h 레짐: 추세 약할 때만(평균회귀 유리) 거래
    h_slope = align(ema(df1h["close"], 20) - ema(df1h["close"], 50), df5.index).abs()
    flat = h_slope < align(atr(df1h), df5.index)  # 1h 추세가 ATR보다 약하면 횡보로 간주
    long = (df5["close"] < lower) & (r < 30) & flat
    short = (df5["close"] > upper) & (r > 70) & flat
    d = pd.Series(0, index=df5.index)
    d[long] = 1
    d[short] = -1
    return {"dir": d, "atr": atr(df5), "rr": 1.0, "lev": 2, "risk": 0.005, "name": "C_평균회귀(5m/1h)"}


def sig_D_mtf(df5, df15, df1h, df4h):
    e15 = align(ema(df15["close"], 20) - ema(df15["close"], 50), df5.index)
    e1h = align(ema(df1h["close"], 20) - ema(df1h["close"], 50), df5.index)
    e4h = align(ema(df4h["close"], 20) - ema(df4h["close"], 50), df5.index)
    long = (e15 > 0) & (e1h > 0) & (e4h > 0)
    short = (e15 < 0) & (e1h < 0) & (e4h < 0)
    d = pd.Series(0, index=df5.index)
    d[long] = 1
    d[short] = -1
    return {"dir": d, "atr": align(atr(df15), df5.index), "rr": 2.5, "lev": 4, "risk": 0.010,
            "name": "D_멀티TF정렬(15m/1h/4h)"}


# ── 백테스트 엔진 (롱/숏, ATR 손절·익절, fixed-fractional 사이징) ──
def run_backtest(df5, sig, atr_mult=1.5, max_lev=None):
    d = sig["dir"].values
    atrv = sig["atr"].reindex(df5.index).bfill().values
    O, H, L, C = (df5[x].values for x in ["open", "high", "low", "close"])
    idx = df5.index
    rr, base_lev, risk = sig["rr"], sig["lev"], sig["risk"]
    cap_lev = max_lev or base_lev

    eq = INIT_EQUITY
    pos = 0           # 0 flat, +1 long, -1 short
    entry = stop = take = notional = 0.0
    entry_i = 0
    eq_curve = np.empty(len(idx))
    trades = []       # (수익률 on equity, 보유봉수)

    for i in range(len(idx)):
        # 포지션 보유 중: 손절/익절/반대신호 체크 (봉 i의 고저로 체결)
        if pos != 0:
            hit = None
            if pos == 1:
                if L[i] <= stop:
                    hit, px = "sl", stop
                elif H[i] >= take:
                    hit, px = "tp", take
            else:
                if H[i] >= stop:
                    hit, px = "sl", stop
                elif L[i] <= take:
                    hit, px = "tp", take
            # 반대 신호면 종가 청산
            if hit is None and d[i] == -pos:
                hit, px = "rev", C[i]
            if hit:
                gross = pos * (px / entry - 1)
                hold = i - entry_i
                funding = FUNDING_PER_8H * hold * 5 / (8 * 60)  # 5m봉 보유시간 비례
                pnl = notional * (gross - ROUND_TRIP_COST - funding)
                eq += pnl
                trades.append((pnl / (eq - pnl), hold))
                pos = 0
                if eq <= INIT_EQUITY * 0.02:   # 사실상 파산
                    eq_curve[i:] = eq
                    break
        # flat 이고 신호 있으면 진입 (봉 i 종가 신호 → 다음 봉 시가 진입 근사: 여기선 종가 진입)
        if pos == 0 and d[i] != 0 and atrv[i] > 0:
            entry = C[i]
            stop_dist = atr_mult * atrv[i] / entry         # 손절폭 (비율)
            if stop_dist > 0:
                # risk%를 손절폭에 맞춰 notional 결정, 레버리지 상한 적용
                notional = min(eq * risk / stop_dist, eq * cap_lev)
                pos = int(d[i])
                stop = entry * (1 - stop_dist) if pos == 1 else entry * (1 + stop_dist)
                take = entry * (1 + rr * stop_dist) if pos == 1 else entry * (1 - rr * stop_dist)
                entry_i = i
        eq_curve[i] = eq

    return pd.Series(eq_curve, index=idx), trades


def stats(eq, trades, idx, name):
    ppy = 365 * 24 * 60 / 5  # 5m봉/년
    ret = eq.pct_change().fillna(0)
    n_years = len(eq) / ppy
    total = eq.iloc[-1] / eq.iloc[0] - 1
    cagr = (eq.iloc[-1] / eq.iloc[0]) ** (1 / n_years) - 1 if n_years > 0 else 0
    sharpe = ret.mean() / ret.std() * np.sqrt(ppy) if ret.std() > 0 else 0
    mdd = (eq / eq.cummax() - 1).min()
    tr = [t[0] for t in trades]
    wins = [t for t in tr if t > 0]
    losses = [t for t in tr if t < 0]
    win_rate = len(wins) / len(tr) * 100 if tr else 0
    avg_w = np.mean(wins) if wins else 0
    avg_l = abs(np.mean(losses)) if losses else 0
    payoff = avg_w / avg_l if avg_l > 0 else float("nan")
    months = n_years * 12
    return {
        "전략": name,
        "총수익(%)": round(total * 100, 1),
        "CAGR(%)": round(cagr * 100, 1),
        "Sharpe": round(sharpe, 2),
        "MDD(%)": round(mdd * 100, 1),
        "거래수": len(tr),
        "거래/월": round(len(tr) / months, 1) if months > 0 else 0,
        "거래/년": round(len(tr) / n_years, 0) if n_years > 0 else 0,
        "승률(%)": round(win_rate, 1),
        "손익비": round(payoff, 2),
    }


def main():
    print("[1/3] 데이터 로드...")
    df5 = load_data()
    df15 = resample(df5, "15min")
    df1h = resample(df5, "1h")
    df4h = resample(df5, "4h")

    print("[2/3] 전략별 백테스트...")
    sigs = [
        sig_A_trend(df5, df15, df1h),
        sig_B_breakout(df5, df15, df1h),
        sig_C_meanrev(df5, df15, df1h),
        sig_D_mtf(df5, df15, df1h, df4h),
    ]
    rows, curves = [], {}
    for sig in sigs:
        eq, trades = run_backtest(df5, sig)
        rows.append(stats(eq, trades, df5.index, sig["name"]))
        curves[sig["name"]] = eq

    print("[3/3] 결과 집계...\n")
    summary = pd.DataFrame(rows).set_index("전략")
    period = f"{df5.index[0].date()} ~ {df5.index[-1].date()}"
    print("=" * 90)
    print(f"심볼 {SYMBOL} 선물 / 기준봉 {BASE_TF} / 기간 {period}")
    print(f"비용: 수수료 {TAKER_FEE*100:.3f}%+슬리피지 {SLIPPAGE*100:.3f}%(편도) + 펀딩 근사 / "
          f"초기자본 {INIT_EQUITY:,.0f}")
    print("사이징: 거래당 risk%를 손절폭에 맞춰 베팅(fixed-fractional), 레버리지 상한 적용")
    print("=" * 90)
    print(summary.to_string())
    print()
    summary.to_csv("multi_strategy_summary.csv", encoding="utf-8-sig")
    pd.DataFrame(curves).to_csv("multi_strategy_equity.csv", encoding="utf-8-sig")
    print("저장: multi_strategy_summary.csv, multi_strategy_equity.csv")


if __name__ == "__main__":
    main()
