# -*- coding: utf-8 -*-
"""
KOSPI 주봉 52주 신고가 전략 백테스트 (2021-01 ~ 현재)

매수 (금요일=주간 마지막 거래일 종가):
  1) 코스피 주간 거래대금 합계 상위 20위 이내
  2) 주봉 종가 > 직전 51개 주봉 고가의 최대값 (52주 신고가 종가 마감)
  3) 해당일 코스피 시가총액 순위 30~50위
매도:
  - 장중 터치 기준 -30% 손절 / +90% 익절 (동일일 양쪽 터치 시 손절 우선 가정)
  - 미도달 시 진입 3개월 후 첫 거래일 종가 청산
  - 동일 종목 중복 보유 없음 (보유 중 재신호 무시)

데이터: marcap (KRX 원본, 무수정주가) → Changes 기반 수정주가 복원
"""
import glob
import os

import numpy as np
import pandas as pd

BASE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
START_SIGNAL = pd.Timestamp("2021-01-01")

# ---------- load ----------
files = sorted(glob.glob(os.path.join(BASE, "marcap-*.parquet")))
cols = ["Code", "Name", "Date", "Open", "High", "Low", "Close",
        "Changes", "Volume", "Amount", "Marcap", "Market"]
df = pd.concat((pd.read_parquet(f, columns=cols) for f in files), ignore_index=True)
df = df[df["Market"] == "KOSPI"].copy()
df["Date"] = pd.to_datetime(df["Date"])
df.sort_values(["Code", "Date"], inplace=True)

LAST_DATE = df["Date"].max()
print(f"데이터: {df['Date'].min().date()} ~ {LAST_DATE.date()}, "
      f"KOSPI 종목수(누적) {df['Code'].nunique()}")

# ---------- 수정주가 복원 ----------
# 기준가 = Close - Changes. factor = 기준가 / 전일종가 (액면분할·감자·증자락 등에서 ≠1)
g = df.groupby("Code", sort=False)
prev_close = g["Close"].shift(1)
base = df["Close"] - df["Changes"]
factor = (base / prev_close).fillna(1.0)
factor = factor.where((factor > 0.005) & (factor < 200), 1.0)
factor = factor.where(prev_close > 0, 1.0)
# 거래정지일(Close 유지, factor 계산 무의미)은 1로
factor = factor.replace([np.inf, -np.inf], 1.0)

# adjmult_t = prod(factor_{t+1..T}) per code → 뒤에서부터 누적
df["_f"] = factor
rev_cum = (df.iloc[::-1].groupby("Code", sort=False)["_f"].cumprod().iloc[::-1])
adjmult = rev_cum / df["_f"]  # exclude own-day factor
for c in ["Open", "High", "Low", "Close"]:
    df["adj" + c] = df[c] * adjmult
df.drop(columns="_f", inplace=True)

# 거래정지일 표시 (OHLC=0, Volume=0)
df["halted"] = (df["Volume"] <= 0) | (df["High"] <= 0)

# ---------- 주봉 생성 (주간 마지막 거래일 기준, 주 = 월~금) ----------
df["wk"] = df["Date"] + pd.to_timedelta(4 - df["Date"].dt.weekday, unit="D")  # 그 주 금요일

active = df[~df["halted"]]
wagg = active.groupby(["Code", "wk"]).agg(
    whigh=("adjHigh", "max"),
    wclose=("adjClose", "last"),
    wclose_raw=("Close", "last"),
    wamount=("Amount", "sum"),
    lastdate=("Date", "max"),
    marcap=("Marcap", "last"),
    name=("Name", "last"),
).reset_index()

# 마지막 미완성 주 제외 (데이터 최종일이 금요일이 아니면 그 주는 신호 제외)
last_wk_complete = LAST_DATE if LAST_DATE.weekday() == 4 else None
max_signal_wk = wagg["wk"].max() if last_wk_complete else wagg["wk"].max() - pd.Timedelta(weeks=0)
if LAST_DATE.weekday() != 4:
    incomplete_wk = LAST_DATE + pd.Timedelta(days=4 - LAST_DATE.weekday())
    print(f"주의: 마지막 주({incomplete_wk.date()} 마감)는 데이터 미완성으로 신호에서 제외")
else:
    incomplete_wk = None

# ---------- 조건 1: 주간 거래대금 상위 20 ----------
wagg["amt_rank"] = wagg.groupby("wk")["wamount"].rank(ascending=False, method="min")

# ---------- 조건 3: 시총 순위 30~50 (주간 마지막 거래일 기준) ----------
daily_rank = df[~df["halted"]].copy()
daily_rank["cap_rank"] = daily_rank.groupby("Date")["Marcap"].rank(ascending=False, method="min")
cap_map = daily_rank.set_index(["Code", "Date"])["cap_rank"]
wagg["cap_rank"] = cap_map.reindex(
    pd.MultiIndex.from_arrays([wagg["Code"], wagg["lastdate"]])).values

# ---------- 조건 2: 52주 신고가 (직전 51개 주봉 고가 최대 < 이번 주 종가) ----------
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

# ---------- 트레이드 시뮬레이션 ----------
STOP, TP = 0.70, 1.90
px = {code: sub[["Date", "adjHigh", "adjLow", "adjClose", "halted"]].reset_index(drop=True)
      for code, sub in df.groupby("Code")}

trades, open_pos = [], {}  # open_pos[code] = exit_date (진행 중 보유 추적)

for _, s in sig.iterrows():
    code, entry_date, entry_px = s["Code"], s["lastdate"], s["wclose"]
    # 보유 중 재신호 무시
    if code in open_pos and open_pos[code] >= entry_date:
        continue
    p = px[code]
    fut = p[(p["Date"] > entry_date) & (~p["halted"])]
    limit_date = entry_date + pd.DateOffset(months=3)
    stop_px, tp_px = entry_px * STOP, entry_px * TP

    exit_date = exit_ret = reason = None
    for _, r in fut.iterrows():
        d = r["Date"]
        is_limit = d >= limit_date
        hit_stop = r["adjLow"] <= stop_px
        hit_tp = r["adjHigh"] >= tp_px
        if hit_stop:                      # 동시 터치 시 손절 우선 (보수적)
            exit_date, exit_ret, reason = d, STOP - 1, "손절(-30%)"
        elif hit_tp:
            exit_date, exit_ret, reason = d, TP - 1, "익절(+90%)"
        elif is_limit:
            exit_date, exit_ret, reason = d, r["adjClose"] / entry_px - 1, "3개월만기"
        if exit_date is not None:
            break
    if exit_date is None:
        last_row = fut.iloc[-1] if len(fut) else None
        if last_row is not None and last_row["Date"] < LAST_DATE - pd.Timedelta(days=10):
            # 데이터가 중간에 끊김 = 상장폐지/장기정지 → 마지막 종가 청산
            exit_date = last_row["Date"]
            exit_ret = last_row["adjClose"] / entry_px - 1
            reason = "상폐/거래중단"
        else:
            # 아직 보유 중 (미청산)
            cur = last_row["adjClose"] / entry_px - 1 if last_row is not None else 0.0
            trades.append(dict(code=code, name=s["name"], entry=entry_date,
                               entry_px=s["wclose_raw"], exit=None, ret=cur,
                               reason="보유중", closed=False))
            open_pos[code] = LAST_DATE
            continue
    trades.append(dict(code=code, name=s["name"], entry=entry_date,
                       entry_px=s["wclose_raw"], exit=exit_date, ret=exit_ret,
                       reason=reason, closed=True))
    open_pos[code] = exit_date

tr = pd.DataFrame(trades)

# ---------- 결과 ----------
closed = tr[tr["closed"]]
open_tr = tr[~tr["closed"]]

print("\n===== 트레이드 목록 =====")
for _, t in tr.iterrows():
    ex = t["exit"].date() if pd.notna(t["exit"]) and t["exit"] is not None else "-"
    print(f"{t['entry'].date()}  {t['name']:<14s} 매수가 {t['entry_px']:>10,.0f}  "
          f"→ {ex}  {t['reason']:<10s} {t['ret']*100:+7.1f}%")

n = len(closed)
wins = (closed["ret"] > 0).sum()
print("\n===== 요약 =====")
print(f"총 진입 횟수        : {len(tr)}  (청산 {n} / 보유중 {len(open_tr)})")
if n:
    print(f"승률 (청산 기준)    : {wins}/{n} = {wins/n*100:.1f}%")
    print(f"종목당 평균 수익률  : {closed['ret'].mean()*100:+.2f}%")
    print(f"누적 수익률(산술합) : {closed['ret'].sum()*100:+.2f}%  (동일금액 투입 가정)")
    print(f"익절 {(closed['reason']=='익절(+90%)').sum()} / 손절 {(closed['reason']=='손절(-30%)').sum()} / "
          f"만기 {(closed['reason']=='3개월만기').sum()} / 상폐·중단 {(closed['reason']=='상폐/거래중단').sum()}")
    mk = closed["ret"][closed["reason"] == "3개월만기"]
    if len(mk):
        print(f"  └ 만기 청산 평균  : {mk.mean()*100:+.2f}%")

# 최대 동시 보유
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

tr.to_csv(os.path.join(BASE, "..", "trades_result.csv"), index=False, encoding="utf-8-sig")
print("\n상세 내역 저장: kr_backtest/trades_result.csv")
