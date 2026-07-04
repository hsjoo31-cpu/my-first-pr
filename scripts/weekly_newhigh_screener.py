# -*- coding: utf-8 -*-
"""
KOSPI 주봉 52주 신고가 스크리너 (주간 자동 실행)

전략 (백테스트 검증 완료: 2021-01~2026-07, 29건, 승률 82.8%, 평균 +27.1%):
  매수 (금요일 = 주간 마지막 거래일 종가):
    1) 코스피 주간 거래대금 합계 상위 10위 이내
    2) 주봉 종가 > 직전 51개 주봉 고가의 최대값 (52주 신고가 종가 마감)
    3) 해당일 코스피 시가총액 순위 30~50위
  매도:
    - +45% 터치 시 보유량 절반 익절 (1차 목표가)
    - 잔여분: -30% 터치 손절 / +90% 터치 익절 (2차 목표가) / 3개월 만기 종가 청산
    - 동일일 손절·익절 동시 터치 시 손절 우선 (보수적)

데이터: marcap (KRX 원본, https://github.com/FinanceData/marcap)
출력: docs/data/newhigh_signals.json
"""
import json
import os
import sys
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "kr_backtest", "data")
OUT = os.path.join(ROOT, "docs", "data", "newhigh_signals.json")

KST = timezone(timedelta(hours=9))
TODAY = datetime.now(KST).date()
START_SIGNAL = pd.Timestamp("2021-01-01")
DATA_START_YEAR = 2020
STOP, PARTIAL, TP = 0.70, 1.45, 1.90
HOLD = pd.DateOffset(months=3)
AMT_RANK_MAX = 10
CAP_RANK_LO, CAP_RANK_HI = 30, 50

# ---------- 데이터 다운로드 ----------
os.makedirs(CACHE, exist_ok=True)
years = range(DATA_START_YEAR, TODAY.year + 1)
for y in years:
    path = os.path.join(CACHE, f"marcap-{y}.parquet")
    url = f"https://github.com/FinanceData/marcap/raw/master/data/marcap-{y}.parquet"
    # 과거 연도는 캐시 재사용, 당해/전년도는 항상 갱신
    if os.path.exists(path) and y < TODAY.year - 1:
        continue
    print(f"다운로드: marcap-{y}.parquet")
    urllib.request.urlretrieve(url, path)

cols = ["Code", "Name", "Date", "Open", "High", "Low", "Close",
        "Changes", "Volume", "Amount", "Marcap", "Market"]
df = pd.concat((pd.read_parquet(os.path.join(CACHE, f"marcap-{y}.parquet"), columns=cols)
                for y in years), ignore_index=True)
df = df[df["Market"] == "KOSPI"].copy()
df["Date"] = pd.to_datetime(df["Date"])
df.sort_values(["Code", "Date"], inplace=True)
LAST_DATE = df["Date"].max()
print(f"데이터: ~ {LAST_DATE.date()}")

# ---------- 데이터 신선도 / 완결 주 판단 ----------
# 최근 금요일 (오늘이 금요일이면 오늘)
last_friday = TODAY - timedelta(days=(TODAY.weekday() - 4) % 7)
if LAST_DATE.date() >= last_friday:
    complete_week = pd.Timestamp(last_friday)
elif (TODAY - last_friday).days >= 3:
    # 월요일 이후에도 금요일 데이터가 없으면 금요일 휴장으로 간주 (목요일 마감 주)
    complete_week = pd.Timestamp(last_friday)
else:
    # 금요일 데이터 아직 미반영 → 직전 주까지만 완결
    complete_week = pd.Timestamp(last_friday) - pd.Timedelta(weeks=1)
    if os.environ.get("REQUIRE_FRESH") == "1":
        print(f"금요일({last_friday}) 데이터 미반영 (최종 {LAST_DATE.date()}) → 갱신 보류")
        sys.exit(0)
print(f"완결 주: {complete_week.date()} 마감")

# ---------- 수정주가 복원 (기준가 = Close - Changes) ----------
g = df.groupby("Code", sort=False)
prev_close = g["Close"].shift(1)
factor = ((df["Close"] - df["Changes"]) / prev_close).fillna(1.0)
factor = factor.where((factor > 0.005) & (factor < 200), 1.0)
factor = factor.where(prev_close > 0, 1.0).replace([np.inf, -np.inf], 1.0)
df["_f"] = factor
rev_cum = df.iloc[::-1].groupby("Code", sort=False)["_f"].cumprod().iloc[::-1]
adjmult = rev_cum / df["_f"]  # 최신일 기준 스케일 (오늘 가격 단위)
for c in ["Open", "High", "Low", "Close"]:
    df["adj" + c] = df[c] * adjmult
df["halted"] = (df["Volume"] <= 0) | (df["High"] <= 0)
df["wk"] = df["Date"] + pd.to_timedelta(4 - df["Date"].dt.weekday, unit="D")

# ---------- 주봉 + 신호 ----------
active = df[~df["halted"]]
wagg = active.groupby(["Code", "wk"]).agg(
    whigh=("adjHigh", "max"), wclose=("adjClose", "last"),
    wclose_raw=("Close", "last"), wamount=("Amount", "sum"),
    lastdate=("Date", "max"), name=("Name", "last"),
).reset_index()

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
    (wagg["amt_rank"] <= AMT_RANK_MAX)
    & (wagg["cap_rank"].between(CAP_RANK_LO, CAP_RANK_HI))
    & (wagg["wclose"] > wagg["prior51max"])
    & (wagg["lastdate"] >= START_SIGNAL)
    & (wagg["wk"] <= complete_week)
].sort_values("lastdate")
print(f"신호 수(중복보유 필터 전): {len(sig)}")

# ---------- V3 시뮬레이션 ----------
px = {code: sub[["Date", "adjHigh", "adjLow", "adjClose", "Close", "halted"]]
      .reset_index(drop=True) for code, sub in df.groupby("Code")}
last_close = df.groupby("Code").agg(cur_raw=("Close", "last"), cur_adj=("adjClose", "last"),
                                    cur_date=("Date", "last"))

closed, holdings, open_pos = [], [], {}
for _, s in sig.iterrows():
    code, entry_date, entry_px = s["Code"], s["lastdate"], s["wclose"]
    if code in open_pos and open_pos[code] >= entry_date:
        continue
    p = px[code]
    fut = p[(p["Date"] > entry_date) & (~p["halted"])]
    limit_date = entry_date + HOLD
    stop_px, part_px, tp_px = entry_px * STOP, entry_px * PARTIAL, entry_px * TP
    partial_done, partial_ret, frac = False, 0.0, 1.0
    partial_date = None
    exit_date = exit_ret = reason = None

    for _, r in fut.iterrows():
        d = r["Date"]
        if r["adjLow"] <= stop_px:
            exit_date, exit_ret = d, partial_ret + frac * (STOP - 1)
            reason = "절반익절→손절" if partial_done else "손절"
            break
        if not partial_done and r["adjHigh"] >= part_px:
            partial_done, partial_ret, frac = True, 0.5 * (PARTIAL - 1), 0.5
            partial_date = d
        if r["adjHigh"] >= tp_px:
            exit_date, exit_ret = d, partial_ret + frac * (TP - 1)
            reason = "절반익절→익절" if partial_done else "익절"
            break
        if d >= limit_date:
            exit_date, exit_ret = d, partial_ret + frac * (r["adjClose"] / entry_px - 1)
            reason = "절반익절→만기" if partial_done else "만기"
            break

    base = dict(code=code, name=s["name"],
                entry_date=str(entry_date.date()), entry_price=float(s["wclose_raw"]))
    if exit_date is not None:
        closed.append({**base, "exit_date": str(exit_date.date()), "reason": reason,
                       "ret": round(exit_ret * 100, 2), "partial": partial_done})
        open_pos[code] = exit_date
        continue

    # 미청산 → 보유중 (데이터 끊긴 상폐 종목은 마지막 종가 청산 처리)
    lastinfo = last_close.loc[code]
    if lastinfo["cur_date"] < LAST_DATE - pd.Timedelta(days=10):
        ret = partial_ret + frac * (lastinfo["cur_adj"] / entry_px - 1)
        closed.append({**base, "exit_date": str(lastinfo["cur_date"].date()),
                       "reason": "상폐/거래중단", "ret": round(ret * 100, 2),
                       "partial": partial_done})
        open_pos[code] = lastinfo["cur_date"]
        continue
    cur_ret = partial_ret + frac * (lastinfo["cur_adj"] / entry_px - 1)
    holdings.append({**base,
                     "current_price": float(lastinfo["cur_raw"]),
                     "current_ret": round(cur_ret * 100, 2),
                     "stop_price": round(entry_px * STOP),
                     "target1_price": round(entry_px * PARTIAL),
                     "target2_price": round(entry_px * TP),
                     "partial_done": partial_done,
                     "partial_date": str(partial_date.date()) if partial_date else None,
                     "expiry_date": str((entry_date + HOLD).date()),
                     "days_left": max(0, ((entry_date + HOLD) - LAST_DATE).days)})
    open_pos[code] = LAST_DATE

# ---------- 신규 신호 (완결 주 금요일 진입분) ----------
new_signals = [h for h in holdings
               if h["entry_date"] == str(sig[sig["wk"] == complete_week]["lastdate"].max().date())
               ] if (sig["wk"] == complete_week).any() else []
# 신규 신호는 entry_px == 현재가이므로 목표/손절가는 매수가 기준 그대로
for h in new_signals:
    h["is_new"] = True

# ---------- 요약 / 연별 / 분기별 ----------
cl = pd.DataFrame(closed)
summary = {}
yearly, quarterly = [], []
if len(cl):
    r = cl["ret"]
    ev = []
    for t in closed:
        ev.append((t["entry_date"], 1))
        ev.append((t["exit_date"], -1))
    for h in holdings:
        ev.append((h["entry_date"], 1))
        ev.append((str(LAST_DATE.date()), -1))
    ev.sort()
    cur = peak = 0
    for _, e in ev:
        cur += e
        peak = max(peak, cur)
    days = (pd.to_datetime(cl["exit_date"]) - pd.to_datetime(cl["entry_date"])).dt.days
    summary = dict(
        n_closed=len(cl), n_open=len(holdings),
        wins=int((r > 0).sum()), win_rate=round((r > 0).mean() * 100, 1),
        avg_ret=round(r.mean(), 2), cum_ret=round(r.sum(), 1),
        max_concurrent=peak, avg_hold_days=round(days.mean()),
        partial_count=int(cl["partial"].sum()),
        backtest_start="2021-01", n_stop=int((cl["reason"] == "손절").sum()),
        n_tp=int(cl["reason"].str.contains("익절→익절|^익절", regex=True).sum()),
    )
    cl["_exit"] = pd.to_datetime(cl["exit_date"])
    for key, fmt in [("yearly", cl["_exit"].dt.year.astype(str)),
                     ("quarterly", cl["_exit"].dt.year.astype(str) + " Q"
                      + cl["_exit"].dt.quarter.astype(str))]:
        grp = cl.groupby(fmt)["ret"].agg(["count", "mean", "sum", lambda x: (x > 0).sum()])
        rows = [dict(period=ix, n=int(row["count"]), wins=int(row["<lambda_0>"]),
                     avg=round(row["mean"], 2), total=round(row["sum"], 1))
                for ix, row in grp.iterrows()]
        (yearly if key == "yearly" else quarterly).extend(rows)

out = dict(
    updated_at=datetime.now(KST).strftime("%Y-%m-%d %H:%M KST"),
    data_last_date=str(LAST_DATE.date()),
    complete_week=str(complete_week.date()),
    params=dict(amt_rank=AMT_RANK_MAX, cap_lo=CAP_RANK_LO, cap_hi=CAP_RANK_HI,
                stop_pct=-30, partial_pct=45, tp_pct=90, hold_months=3),
    new_signals=new_signals,
    holdings=sorted(holdings, key=lambda h: h["entry_date"], reverse=True),
    closed=sorted(closed, key=lambda t: t["exit_date"], reverse=True),
    summary=summary, yearly=yearly, quarterly=quarterly,
)
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, indent=1)
print(f"저장: {OUT}")
print(f"신규신호 {len(new_signals)} / 보유 {len(holdings)} / 청산 {len(closed)}")
