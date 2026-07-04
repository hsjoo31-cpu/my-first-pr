# -*- coding: utf-8 -*-
"""
V2: 동일 매수조건, 매도 규칙 변경
  - 최대 보유기간 1개월 (만기일 종가 청산)
  - +45% 터치 시 비중 절반 익절, 나머지 절반은 원래 계획 유지 (-30% 손절 / +90% 익절 / 만기)
  - 동일일 손절·익절 동시 터치 시 손절 우선 (보수적)
"""
import glob
import os

import numpy as np
import pandas as pd

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
START_SIGNAL = pd.Timestamp("2021-01-01")
STOP, PARTIAL, TP = 0.70, 1.45, 1.90
HOLD = pd.DateOffset(months=1)

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
    wclose_raw=("Close", "last"), wamount=("Amount", "sum"),
    lastdate=("Date", "max"), name=("Name", "last"),
).reset_index()

incomplete_wk = None
if LAST_DATE.weekday() != 4:
    incomplete_wk = LAST_DATE + pd.Timedelta(days=4 - LAST_DATE.weekday())

wagg["amt_rank"] = wagg.groupby("wk")["wamount"].rank(ascending=False, method="min")
daily_rank = df[~df["halted"]].copy()
daily_rank["cap_rank"] = daily_rank.groupby("Date")["Marcap"].rank(ascending=False, method="min")
cap_map = daily_rank.set_index(["Code", "Date"])["cap_rank"]
wagg["cap_rank"] = cap_map.reindex(
    pd.MultiIndex.from_arrays([wagg["Code"], wagg["lastdate"]])).values
wagg.sort_values(["Code", "wk"], inplace=True)
wagg["prior51max"] = (wagg.groupby("Code")["whigh"]
                      .transform(lambda s: s.shift(1).rolling(51, min_periods=51).max()))

sig = wagg[
    (wagg["amt_rank"] <= 20)
    & (wagg["cap_rank"].between(30, 50))
    & (wagg["wclose"] > wagg["prior51max"])
    & (wagg["lastdate"] >= START_SIGNAL)
].copy()
if incomplete_wk is not None:
    sig = sig[sig["wk"] != incomplete_wk]
sig.sort_values("lastdate", inplace=True)
print(f"신호 수(중복보유 필터 전): {len(sig)}")

px = {code: sub[["Date", "adjHigh", "adjLow", "adjClose", "halted"]].reset_index(drop=True)
      for code, sub in df.groupby("Code")}

trades, open_pos = [], {}
for _, s in sig.iterrows():
    code, entry_date, entry_px = s["Code"], s["lastdate"], s["wclose"]
    if code in open_pos and open_pos[code] >= entry_date:
        continue
    p = px[code]
    fut = p[(p["Date"] > entry_date) & (~p["halted"])]
    limit_date = entry_date + HOLD
    stop_px, part_px, tp_px = entry_px * STOP, entry_px * PARTIAL, entry_px * TP

    partial_done = False
    partial_ret = 0.0   # 절반 익절분의 기여 (0.5 * 45%)
    frac = 1.0          # 남은 비중
    exit_date = exit_ret = reason = None

    for _, r in fut.iterrows():
        d = r["Date"]
        # 1) 손절 우선 (보수적)
        if r["adjLow"] <= stop_px:
            exit_date = d
            exit_ret = partial_ret + frac * (STOP - 1)
            reason = ("절반익절→손절" if partial_done else "손절(-30%)")
            break
        # 2) +45% 절반 익절
        if not partial_done and r["adjHigh"] >= part_px:
            partial_done = True
            partial_ret = 0.5 * (PARTIAL - 1)
            frac = 0.5
        # 3) +90% 전량 익절
        if r["adjHigh"] >= tp_px:
            exit_date = d
            exit_ret = partial_ret + frac * (TP - 1)
            reason = ("절반익절→익절" if partial_done else "익절(+90%)")
            break
        # 4) 1개월 만기 종가 청산
        if d >= limit_date:
            exit_date = d
            exit_ret = partial_ret + frac * (r["adjClose"] / entry_px - 1)
            reason = ("절반익절→만기" if partial_done else "1개월만기")
            break

    if exit_date is None:
        last_row = fut.iloc[-1] if len(fut) else None
        if last_row is not None and last_row["Date"] < LAST_DATE - pd.Timedelta(days=10):
            exit_date = last_row["Date"]
            exit_ret = partial_ret + frac * (last_row["adjClose"] / entry_px - 1)
            reason = "상폐/거래중단"
        else:
            cur = (partial_ret + frac * (last_row["adjClose"] / entry_px - 1)
                   if last_row is not None else 0.0)
            trades.append(dict(code=code, name=s["name"], entry=entry_date,
                               entry_px=s["wclose_raw"], exit=None, ret=cur,
                               reason="보유중", closed=False, partial=partial_done))
            open_pos[code] = LAST_DATE
            continue
    trades.append(dict(code=code, name=s["name"], entry=entry_date,
                       entry_px=s["wclose_raw"], exit=exit_date, ret=exit_ret,
                       reason=reason, closed=True, partial=partial_done))
    open_pos[code] = exit_date

tr = pd.DataFrame(trades)
closed = tr[tr["closed"]]
open_tr = tr[~tr["closed"]]

print("\n===== 트레이드 목록 =====")
for _, t in tr.iterrows():
    ex = t["exit"].date() if pd.notna(t["exit"]) and t["exit"] is not None else "-"
    print(f"{t['entry'].date()}  {t['name']:<14s} 매수가 {t['entry_px']:>10,.0f}  "
          f"→ {ex}  {t['reason']:<12s} {t['ret']*100:+7.1f}%")

n = len(closed)
wins = (closed["ret"] > 0).sum()
print("\n===== 요약 (V2: 1개월 보유 / +45% 절반익절) =====")
print(f"총 진입 횟수        : {len(tr)}  (청산 {n} / 보유중 {len(open_tr)})")
if n:
    print(f"승률 (청산 기준)    : {wins}/{n} = {wins/n*100:.1f}%")
    print(f"종목당 평균 수익률  : {closed['ret'].mean()*100:+.2f}%")
    print(f"누적 수익률(산술합) : {closed['ret'].sum()*100:+.2f}%")
    print(f"절반익절 발생       : {closed['partial'].sum()}회 / {n}회")
    print("청산 유형별:")
    for reason, grp in closed.groupby("reason"):
        print(f"  {reason:<12s}: {len(grp):3d}회  평균 {grp['ret'].mean()*100:+7.2f}%")

events = []
for _, t in tr.iterrows():
    end = t["exit"] if t["closed"] else LAST_DATE
    events.append((t["entry"], 1))
    events.append((end, -1))
events.sort()
cur = peak = 0
peak_date = None
for d, e in events:
    cur += e
    if cur > peak:
        peak, peak_date = cur, d
print(f"최대 동시 보유 종목 : {peak}개 (도달 시점 {peak_date.date() if peak_date else '-'})")

tr.to_csv(os.path.join(BASE, "..", "trades_result_v2.csv"), index=False, encoding="utf-8-sig")
print("\n상세 내역 저장: kr_backtest/trades_result_v2.csv")
