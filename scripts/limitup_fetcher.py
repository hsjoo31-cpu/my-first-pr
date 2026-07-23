# -*- coding: utf-8 -*-
"""
상한가(±30% 상한) 다음날 매매 백테스트 데이터 수집기

컨셉:
  - 2023-01-01 이후, KRX 시세(marcap 원본) 기준 상한가로 마감한 종목 이벤트를 수집.
  - 상한가일 종가 기준 시가총액 1조원 이상만 대상(대형주 상한가 = 주도 이벤트).
  - 각 이벤트의 '다음 거래일' 시초가/고가/저가/종가(원가격)를 함께 저장.
  - 프론트엔드가 목표수익률(T%)을 바꿔가며:
        매수 = 다음 거래일 시초가
        목표달성(고가 >= 시초가*(1+T%)) → +T% 익절
        미달성 → 당일(= 매수일) 종가 매도
    로 백테스트한다.

상한가 판정:
  일간 등락률(Changes / 전일종가)이 +29.0% ~ +31.0% 밴드 → 상한가(±30% 제도).
  상장 첫날(공모가 대비 변동)·이상치는 이 밴드 필터로 자연 배제된다.

데이터: marcap (KRX 원본, https://github.com/FinanceData/marcap)
출력:   docs/data/limitup_data.json

* 단일일(당일 매수·당일 청산) 전략이라 수정주가 보정 불필요 —
  다음 거래일 시초/고/저/종가는 모두 같은 날 원가격이라 자기정합적이다.
"""
import json
import os
import urllib.request
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "kr_backtest", "data")
OUT = os.path.join(ROOT, "docs", "data", "limitup_data.json")

KST = timezone(timedelta(hours=9))
TODAY = datetime.now(KST).date()

START = pd.Timestamp("2023-01-01")     # 상한가 이벤트 시작일
DATA_START_YEAR = 2022                  # 전일종가 계산용으로 1년 앞부터 로드
MIN_MARCAP = 1_000_000_000_000          # 시가총액 하한 (1조원)
LIMIT_LO, LIMIT_HI = 0.29, 0.31         # 상한가 등락률 밴드 (±30% 제도)
MARKETS = {"KOSPI", "KOSDAQ", "KOSDAQ GLOBAL"}   # KRX 정규시장 (KONEX 제외)

# ---------- 데이터 다운로드 (없으면) ----------
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
df = df[df["Market"].isin(MARKETS)].copy()
df["Date"] = pd.to_datetime(df["Date"])
# 실제 체결 가능한 거래일만: OHLC 모두 양수 & 거래량 > 0 (거래정지·결측일 제외)
df = df[(df["Open"] > 0) & (df["High"] > 0) & (df["Low"] > 0) &
        (df["Close"] > 0) & (df["Volume"] > 0)].copy()
df.sort_values(["Code", "Date"], inplace=True)
LAST_DATE = df["Date"].max()
print(f"데이터: ~ {LAST_DATE.date()} / {df['Code'].nunique()}개 종목")

# ---------- 상한가 판정 + 다음 거래일 붙이기 ----------
g = df.groupby("Code", sort=False)
prev_close = g["Close"].shift(1)
ret = (df["Close"] - prev_close) / prev_close      # 전일종가 대비 등락률
df["ret0"] = ret

# 다음 거래일(같은 종목의 다음 유효 거래행)의 시초/고/저/종가 + 날짜
for c, src in [("n_open", "Open"), ("n_high", "High"),
               ("n_low", "Low"), ("n_close", "Close")]:
    df[c] = g[src].shift(-1)
df["n_date"] = g["Date"].shift(-1)

is_limit = ret.between(LIMIT_LO, LIMIT_HI)
events = df[
    is_limit
    & (df["Date"] >= START)
    & (df["Marcap"] >= MIN_MARCAP)
    & df["n_open"].notna()          # 다음 거래일이 있어야 매매 가능
].copy()
print(f"상한가 이벤트(시총 {MIN_MARCAP/1e12:.0f}조+): {len(events)}건")

# ---------- 이벤트 레코드 ----------
records = []
for _, r in events.iterrows():
    n_date = r["n_date"]
    gap_days = (n_date - r["Date"]).days          # 다음 거래일까지 달력일수(거래정지 감지용)
    records.append({
        "code":   r["Code"],
        "name":   str(r["Name"]),
        "market": "KOSDAQ" if r["Market"] == "KOSDAQ GLOBAL" else r["Market"],
        "d0":     r["Date"].strftime("%Y-%m-%d"),      # 상한가일
        "c0":     int(r["Close"]),                     # 상한가일 종가
        "ret0":   round(float(r["ret0"]) * 100, 2),    # 상한가일 등락률(%)
        "cap":    int(round(r["Marcap"] / 1e8)),       # 시가총액(억원)
        "d1":     n_date.strftime("%Y-%m-%d"),         # 매수일(다음 거래일)
        "o1":     int(r["n_open"]),
        "h1":     int(r["n_high"]),
        "l1":     int(r["n_low"]),
        "c1":     int(r["n_close"]),
        "gap_days": int(gap_days),
    })

records.sort(key=lambda x: (x["d0"], -x["cap"]))

out = {
    "updated_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M KST"),
    "data_last_date": str(LAST_DATE.date()),
    "params": {
        "start": str(START.date()),
        "min_marcap_eok": int(MIN_MARCAP / 1e8),
        "markets": sorted(MARKETS),
    },
    "events": records,
}
os.makedirs(os.path.dirname(OUT), exist_ok=True)
with open(OUT, "w", encoding="utf-8") as f:
    json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

# ---------- 검증 로그 ----------
n_susp = sum(1 for r in records if r["gap_days"] > 4)
print(f"저장: {OUT}  ({len(records)}건)")
print(f"  기간: {records[0]['d0'] if records else '-'} ~ {records[-1]['d0'] if records else '-'}")
print(f"  다음거래일 갭>4일(거래정지 의심): {n_susp}건")
by_year = {}
for r in records:
    by_year.setdefault(r["d0"][:4], 0)
    by_year[r["d0"][:4]] += 1
print("  연도별:", by_year)
