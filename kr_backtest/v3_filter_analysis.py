# -*- coding: utf-8 -*-
"""
V3(3개월 보유 / +45% 절반익절 / -30%/+90%) 기준,
진입 횟수를 줄이면서 성과를 유지·개선할 추가 필터 탐색.

1) 트레이드별 특성값 수집 → 승패 구분력 분석
2) 후보 필터별 전체 재시뮬레이션 (중복보유 필터 재적용) → 지표 비교
"""
import glob
import os

import numpy as np
import pandas as pd

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
START_SIGNAL = pd.Timestamp("2021-01-01")
STOP, PARTIAL, TP = 0.70, 1.45, 1.90
HOLD = pd.DateOffset(months=3)

files = sorted(glob.glob(os.path.join(BASE, "marcap-*.parquet")))
cols = ["Code", "Name", "Date", "Open", "High", "Low", "Close",
        "Changes", "Volume", "Amount", "Marcap", "Market"]
df = pd.concat((pd.read_parquet(f, columns=cols) for f in files), ignore_index=True)
df = df[df["Market"] == "KOSPI"].copy()
df["Date"] = pd.to_datetime(df["Date"])
df.sort_values(["Code", "Date"], inplace=True)
LAST_DATE = df["Date"].max()

g = df.groupby("Code", sort=False)
prev_close = g["Close"].shift(1)
factor = ((df["Close"] - df["Changes"]) / prev_close).fillna(1.0)
factor = factor.where((factor > 0.005) & (factor < 200), 1.0)
factor = factor.where(prev_close > 0, 1.0).replace([np.inf, -np.inf], 1.0)
df["_f"] = factor
rev_cum = df.iloc[::-1].groupby("Code", sort=False)["_f"].cumprod().iloc[::-1]
adjmult = rev_cum / df["_f"]
for c in ["Open", "High", "Low", "Close"]:
    df["adj" + c] = df[c] * adjmult
df["halted"] = (df["Volume"] <= 0) | (df["High"] <= 0)
df["wk"] = df["Date"] + pd.to_timedelta(4 - df["Date"].dt.weekday, unit="D")

active = df[~df["halted"]]
wagg = active.groupby(["Code", "wk"]).agg(
    whigh=("adjHigh", "max"), wclose=("adjClose", "last"),
    wlow=("adjLow", "min"), wopen=("adjOpen", "first"),
    wclose_raw=("Close", "last"), wamount=("Amount", "sum"),
    lastdate=("Date", "max"), name=("Name", "last"),
).reset_index()

incomplete_wk = LAST_DATE + pd.Timedelta(days=4 - LAST_DATE.weekday()) if LAST_DATE.weekday() != 4 else None

wagg["amt_rank"] = wagg.groupby("wk")["wamount"].rank(ascending=False, method="min")
daily_rank = df[~df["halted"]].copy()
daily_rank["cap_rank"] = daily_rank.groupby("Date")["Marcap"].rank(ascending=False, method="min")
cap_map = daily_rank.set_index(["Code", "Date"])["cap_rank"]
wagg["cap_rank"] = cap_map.reindex(
    pd.MultiIndex.from_arrays([wagg["Code"], wagg["lastdate"]])).values

wagg.sort_values(["Code", "wk"], inplace=True)
gw = wagg.groupby("Code")
wagg["prior51max"] = gw["whigh"].transform(lambda s: s.shift(1).rolling(51, min_periods=51).max())
# --- 특성값 ---
wagg["breakout"] = wagg["wclose"] / wagg["prior51max"] - 1          # 돌파 강도
wagg["wret"] = gw["wclose"].transform(lambda s: s / s.shift(1) - 1)  # 신호 주 수익률
wagg["ret4w"] = gw["wclose"].transform(lambda s: s / s.shift(4) - 1) # 최근 4주 수익률
wagg["ret13w"] = gw["wclose"].transform(lambda s: s / s.shift(13) - 1)
# 캔들 위치: 종가가 주봉 레인지 상단에 얼마나 가까운가
rng = (wagg["whigh"] - wagg["wlow"])
wagg["close_pos"] = np.where(rng > 0, (wagg["wclose"] - wagg["wlow"]) / rng, 1.0)

base_sig = wagg[
    (wagg["amt_rank"] <= 20)
    & (wagg["cap_rank"].between(30, 50))
    & (wagg["wclose"] > wagg["prior51max"])
    & (wagg["lastdate"] >= START_SIGNAL)
].copy()
if incomplete_wk is not None:
    base_sig = base_sig[base_sig["wk"] != incomplete_wk]
base_sig.sort_values("lastdate", inplace=True)

px = {code: sub[["Date", "adjHigh", "adjLow", "adjClose", "halted"]].reset_index(drop=True)
      for code, sub in df.groupby("Code")}


def simulate(sig):
    """V3 규칙 시뮬레이션. 반환: trades DataFrame"""
    trades, open_pos = [], {}
    for _, s in sig.iterrows():
        code, entry_date, entry_px = s["Code"], s["lastdate"], s["wclose"]
        if code in open_pos and open_pos[code] >= entry_date:
            continue
        p = px[code]
        fut = p[(p["Date"] > entry_date) & (~p["halted"])]
        limit_date = entry_date + HOLD
        stop_px, part_px, tp_px = entry_px * STOP, entry_px * PARTIAL, entry_px * TP
        partial_done, partial_ret, frac = False, 0.0, 1.0
        exit_date = exit_ret = reason = None
        for _, r in fut.iterrows():
            d = r["Date"]
            if r["adjLow"] <= stop_px:
                exit_date, exit_ret = d, partial_ret + frac * (STOP - 1)
                reason = "절반익절→손절" if partial_done else "손절"
                break
            if not partial_done and r["adjHigh"] >= part_px:
                partial_done, partial_ret, frac = True, 0.5 * (PARTIAL - 1), 0.5
            if r["adjHigh"] >= tp_px:
                exit_date, exit_ret = d, partial_ret + frac * (TP - 1)
                reason = "절반익절→익절" if partial_done else "익절"
                break
            if d >= limit_date:
                exit_date, exit_ret = d, partial_ret + frac * (r["adjClose"] / entry_px - 1)
                reason = "절반익절→만기" if partial_done else "만기"
                break
        if exit_date is None:
            last_row = fut.iloc[-1] if len(fut) else None
            if last_row is None:
                continue
            exit_date = last_row["Date"]
            exit_ret = partial_ret + frac * (last_row["adjClose"] / entry_px - 1)
            reason = "보유중/중단"
        trades.append(dict(code=code, name=s["name"], entry=entry_date, exit=exit_date,
                           ret=exit_ret, reason=reason,
                           amt_rank=s["amt_rank"], cap_rank=s["cap_rank"],
                           breakout=s["breakout"], wret=s["wret"],
                           ret4w=s["ret4w"], ret13w=s["ret13w"], close_pos=s["close_pos"]))
        open_pos[code] = exit_date
    return pd.DataFrame(trades)


def metrics(tr, label):
    r = tr["ret"]
    events = []
    for _, t in tr.iterrows():
        events.append((t["entry"], 1))
        events.append((t["exit"], -1))
    events.sort()
    cur = peak = 0
    for d, e in events:
        cur += e
        peak = max(peak, cur)
    return dict(label=label, n=len(tr), win=f"{(r>0).mean()*100:.0f}%",
                avg=f"{r.mean()*100:+.1f}%", cum=f"{r.sum()*100:+.0f}%",
                std=f"{r.std()*100:.0f}%p", max_pos=peak)


# ---------- 1) 기준 V3 트레이드 + 특성 분석 ----------
tr0 = simulate(base_sig)
print(f"기준 V3: {len(tr0)}건")
print("\n===== 특성값별 승패 구분력 (승리=수익>0) =====")
for feat, desc in [("amt_rank", "주간 거래대금 순위"), ("cap_rank", "시총 순위"),
                   ("breakout", "돌파 강도(종가/직전51주고가-1)"),
                   ("wret", "신호 주 수익률"), ("ret4w", "최근 4주 수익률"),
                   ("ret13w", "최근 13주 수익률"), ("close_pos", "주봉 종가 위치(0~1)")]:
    tr0["_q"] = pd.qcut(tr0[feat], 3, labels=["하", "중", "상"], duplicates="drop")
    s = tr0.groupby("_q", observed=True)["ret"].agg(["count", "mean", lambda x: (x > 0).mean()])
    s.columns = ["건수", "평균수익", "승률"]
    line = " | ".join(f"{ix}: n={int(row['건수'])}, 평균 {row['평균수익']*100:+.1f}%, 승률 {row['승률']*100:.0f}%"
                      for ix, row in s.iterrows())
    print(f"{desc:<24s} {line}")

# ---------- 2) 후보 필터 재시뮬레이션 ----------
print("\n===== 후보 필터별 V3 재시뮬레이션 =====")
cands = [
    ("기준 V3 (필터 없음)", base_sig),
    ("거래대금 상위 10위", base_sig[base_sig["amt_rank"] <= 10]),
    ("거래대금 상위 5위", base_sig[base_sig["amt_rank"] <= 5]),
    ("돌파강도 > 3%", base_sig[base_sig["breakout"] > 0.03]),
    ("돌파강도 > 5%", base_sig[base_sig["breakout"] > 0.05]),
    ("돌파강도 < 10% (과열 제외)", base_sig[base_sig["breakout"] < 0.10]),
    ("신호주 수익률 < 15%", base_sig[base_sig["wret"] < 0.15]),
    ("신호주 수익률 > 5%", base_sig[base_sig["wret"] > 0.05]),
    ("4주 수익률 < 30% (과열 제외)", base_sig[base_sig["ret4w"] < 0.30]),
    ("4주 수익률 > 15% (모멘텀 강)", base_sig[base_sig["ret4w"] > 0.15]),
    ("13주 수익률 < 50% (과열 제외)", base_sig[base_sig["ret13w"] < 0.50]),
    ("종가위치 > 0.7 (강한 마감)", base_sig[base_sig["close_pos"] > 0.7]),
    ("시총 35~50위", base_sig[base_sig["cap_rank"] >= 35]),
    ("시총 30~45위", base_sig[base_sig["cap_rank"] <= 45]),
]
rows = [metrics(simulate(s), lb) for lb, s in cands]
out = pd.DataFrame(rows)
print(out.to_string(index=False))
