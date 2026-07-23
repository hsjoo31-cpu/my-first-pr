# -*- coding: utf-8 -*-
"""외국인 따라가기 백테스트 데이터 수집 스크립트

전략 컨셉:
  주간/월간 기준 외국인 순매수 상위(우선주 제외) 종목을 동일 비중 매수,
  종목당 목표수익률/로스컷 또는 최대보유기간(리밸런싱) 만료 종가에 매도.

데이터 소스 (KRX 정보데이터시스템이 로그인 게이트되어 사용 불가):
  1) marcap parquet (https://github.com/FinanceData/marcap)
       - 일봉 OHLC(무수정) + Changes(전일대비) → 수정주가 복원
       - Marcap(시가총액) → 유니버스(시총 상위) 산정
       - 무수정 Close × 외국인 순매수 수량 = 외국인 순매수 거래대금(근사)
  2) 네이버 모바일 API (m.stock.naver.com/api/stock/{code}/trend)
       - 종목별 일별 외국인 순매수 '수량' + 종가 (pageSize<=60)

외국인 순매수 랭킹은 '순매수 거래대금' 기준(= Σ 일별 순매수수량 × 종가).
유니버스는 월말 시가총액 상위 100위(KOSPI/KOSDAQ 각각)의 합집합 —
외국인 순매수 상위(대금 기준)는 사실상 대형주에 집중되므로 이 범위로 충분히 포괄된다.

수정주가 주의:
  - 랭킹(순매수 대금)은 '무수정' 가격 기준 (그 시점 실제 거래대금).
  - 백테스트 손익(목표/로스컷/만기)은 '수정주가' 기준 (분할·증자 왜곡 제거).
  두 계산에서 가격 기준을 분리해 어느 쪽에도 오류가 생기지 않도록 한다.

출력: docs/data/foreign_follow.json
캐시: kr_backtest/data/naver_foreign.json (증분 갱신)
"""
import json
import os
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

import numpy as np
import pandas as pd
import requests

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, "kr_backtest", "data")  # marcap parquet (gitignore)
# 네이버 원본 캐시는 CI 증분 갱신을 위해 커밋되는 경로에 둔다(과거 순매수 수량은 불변).
NAVER_CACHE = os.path.join(ROOT, "data_cache", "naver_foreign.json")
OUT = os.path.join(ROOT, "docs", "data", "foreign_follow.json")

KST = timezone(timedelta(hours=9))
TODAY = datetime.now(KST).date()
START = pd.Timestamp("2023-01-01")
DATA_START_YEAR = 2022  # 51일 이전 수정계수·직전월 데이터 여유
CAP_TOP = 100           # 시총 상위 N위(시장별) 합집합을 유니버스로
TOPK = 20               # 저장할 순매수 상위 랭킹 수
NAVER_WORKERS = 8
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36"
NAVER_HEADERS = {"User-Agent": UA, "Referer": "https://m.stock.naver.com/"}
LIMIT = int(os.environ.get("FF_LIMIT", "0"))  # >0이면 유니버스 앞 N개만(테스트용)


# ────────────────────────────────────────────────────────────
# 1. marcap 로드 + 수정주가 복원
# ────────────────────────────────────────────────────────────
def load_marcap():
    os.makedirs(CACHE, exist_ok=True)
    years = range(DATA_START_YEAR, TODAY.year + 1)
    for y in years:
        path = os.path.join(CACHE, f"marcap-{y}.parquet")
        url = f"https://github.com/FinanceData/marcap/raw/master/data/marcap-{y}.parquet"
        if os.path.exists(path) and y < TODAY.year - 1:
            continue
        print(f"다운로드: marcap-{y}.parquet")
        urllib.request.urlretrieve(url, path)

    cols = ["Code", "Name", "Date", "Open", "High", "Low", "Close",
            "Changes", "Volume", "Amount", "Marcap", "Market"]
    df = pd.concat((pd.read_parquet(os.path.join(CACHE, f"marcap-{y}.parquet"), columns=cols)
                    for y in years), ignore_index=True)
    df = df[df["Market"].isin(["KOSPI", "KOSDAQ", "KOSDAQ GLOBAL"])].copy()
    # 우선주 제외: 보통주 코드 끝자리 '0'
    df = df[df["Code"].str[-1] == "0"]
    df["Date"] = pd.to_datetime(df["Date"])
    df["mkt"] = np.where(df["Market"] == "KOSPI", "KOSPI", "KOSDAQ")
    df.sort_values(["Code", "Date"], inplace=True)
    df.reset_index(drop=True, inplace=True)

    # 수정계수 복원 (기준가 = Close - Changes)
    g = df.groupby("Code", sort=False)
    prev_close = g["Close"].shift(1)
    factor = ((df["Close"] - df["Changes"]) / prev_close).fillna(1.0)
    factor = factor.where((factor > 0.005) & (factor < 200), 1.0)
    factor = factor.where(prev_close > 0, 1.0).replace([np.inf, -np.inf], 1.0)
    df["_f"] = factor
    rev_cum = df.iloc[::-1].groupby("Code", sort=False)["_f"].cumprod().iloc[::-1]
    adjmult = rev_cum / df["_f"]  # 최신일=1 기준 스케일(오늘 가격 단위)
    for c in ["Open", "High", "Low", "Close"]:
        df["adj" + c] = df[c] * adjmult
    df["halted"] = (df["Volume"] <= 0) | (df["High"] <= 0)
    return df


# ────────────────────────────────────────────────────────────
# 2. 유니버스 (월말 시총 상위 합집합)
# ────────────────────────────────────────────────────────────
def build_universe(df):
    d = df[(df["Date"] >= START) & (~df["halted"])].copy()
    d["mo"] = d["Date"].values.astype("datetime64[M]")
    me = d.sort_values("Date").groupby(["mkt", "mo", "Code"]).last().reset_index()
    me["rank"] = me.groupby(["mkt", "mo"])["Marcap"].rank(ascending=False, method="min")
    uni = sorted(me[me["rank"] <= CAP_TOP]["Code"].unique().tolist())
    if LIMIT:
        uni = uni[:LIMIT]
    print(f"유니버스: {len(uni)}종목 (월말 시총 상위 {CAP_TOP}위 합집합)")
    return uni


# ────────────────────────────────────────────────────────────
# 3. 네이버 외국인 순매수 수량 (증분 캐시)
# ────────────────────────────────────────────────────────────
def load_cache():
    if os.path.exists(NAVER_CACHE):
        try:
            return json.load(open(NAVER_CACHE, encoding="utf-8"))
        except Exception:
            return {}
    return {}


def fetch_naver(code, have_dates):
    """{yyyymmdd: net_shares}. have_dates: 이미 캐시된 날짜 set(증분 중단용)."""
    out = {}
    biz = None
    start_yyyymmdd = START.strftime("%Y%m%d")
    for _ in range(40):  # 안전 상한
        url = f"https://m.stock.naver.com/api/stock/{code}/trend?pageSize=60"
        if biz:
            url += f"&bizdate={biz}"
        try:
            r = requests.get(url, headers=NAVER_HEADERS, timeout=15)
            data = r.json()
        except Exception:
            time.sleep(0.5)
            try:
                data = requests.get(url, headers=NAVER_HEADERS, timeout=15).json()
            except Exception:
                break
        if not data:
            break
        hit_cached = False
        for row in data:
            d = row["bizdate"]
            q = row.get("foreignerPureBuyQuant", "")
            q = str(q).replace(",", "").replace("+", "").strip()
            try:
                out[d] = int(q)
            except ValueError:
                out[d] = 0
            if d in have_dates:
                hit_cached = True
        oldest = data[-1]["bizdate"]
        if oldest <= start_yyyymmdd or hit_cached:
            break
        biz = oldest
        time.sleep(0.05)
    return code, out


def fetch_all_naver(uni, cache):
    todo = uni
    print(f"네이버 외국인 순매수 수집: {len(todo)}종목 (워커 {NAVER_WORKERS})")
    done = 0
    with ThreadPoolExecutor(max_workers=NAVER_WORKERS) as ex:
        futs = {ex.submit(fetch_naver, c, set(cache.get(c, {}).keys())): c for c in todo}
        for fut in as_completed(futs):
            code, out = fut.result()
            if out:
                merged = cache.get(code, {})
                merged.update(out)
                cache[code] = merged
            done += 1
            if done % 25 == 0:
                print(f"  {done}/{len(todo)}")
    os.makedirs(os.path.dirname(NAVER_CACHE), exist_ok=True)
    json.dump(cache, open(NAVER_CACHE, "w", encoding="utf-8"))
    print(f"캐시 저장: {NAVER_CACHE}")
    return cache


# ────────────────────────────────────────────────────────────
# 4. 랭킹 + 백테스트용 데이터 구성
# ────────────────────────────────────────────────────────────
def build(df, uni, cache, last_date):
    d = df[(df["Date"] >= START) & (df["Code"].isin(uni))].copy()
    # 외국인 순매수 수량 매핑 (yyyymmdd)
    d["ymd"] = d["Date"].dt.strftime("%Y%m%d")
    net_shares = np.zeros(len(d), dtype="float64")
    codes = d["Code"].values
    ymds = d["ymd"].values
    for i in range(len(d)):
        net_shares[i] = cache.get(codes[i], {}).get(ymds[i], 0)
    d["net_shares"] = net_shares
    # 순매수 거래대금(근사) = 순매수수량 × 무수정 종가. 거래정지일은 0.
    d["net_val"] = np.where(d["halted"], 0.0, d["net_shares"] * d["Close"])

    # 주간(금요일 앵커) / 월간 그룹 키
    d["wk"] = d["Date"] + pd.to_timedelta(4 - d["Date"].dt.weekday, unit="D")
    d["mo"] = d["Date"].values.astype("datetime64[M]")

    name_map = df.groupby("Code")["Name"].last().to_dict()
    mkt_map = df.groupby("Code")["mkt"].last().to_dict()

    periods = {"weekly": {}, "monthly": {}}
    used_codes = set()

    # 미완결(진행 중) 기간 제외 — 부분 데이터로 순매수 랭킹이 왜곡되는 것을 방지
    cur_week_fri = pd.Timestamp(last_date) + pd.to_timedelta(4 - last_date.weekday(), unit="D")
    cur_month = pd.Timestamp(last_date).replace(day=1)

    def is_complete(ptype, pkey):
        if ptype == "weekly":
            return pkey <= pd.Timestamp(last_date)  # 금요일 앵커가 데이터 최종일 이내
        return pkey < cur_month  # 진행 중인 당월 제외

    for ptype, gcol in [("weekly", "wk"), ("monthly", "mo")]:
        # 각 종목의 기간별 순매수대금 합계 + 기간 마지막 거래일
        grp = d.groupby([gcol, "Code"]).agg(
            val=("net_val", "sum"), last=("Date", "max")).reset_index()
        # 기간 마지막 거래일에 정상 거래(체결 가능)한 종목만 진입 대상
        entry_ok = d[~d["halted"]].groupby([gcol, "Code"])["Date"].max().reset_index()
        entry_ok = set(zip(entry_ok[gcol], entry_ok["Code"], entry_ok["Date"]))
        grp = grp[[(r[gcol], r["Code"], r["last"]) in entry_ok for _, r in grp.iterrows()]]

        for scope in ["ALL", "KOSPI", "KOSDAQ"]:
            sub = grp if scope == "ALL" else grp[grp["Code"].map(mkt_map) == scope]
            rows = []
            for pkey, block in sub.groupby(gcol):
                if not is_complete(ptype, pkey):
                    continue
                block = block[block["val"] > 0]  # 순매수(양수)만 상위 랭킹
                if block.empty:
                    continue
                block = block.sort_values("val", ascending=False).head(TOPK)
                # 기간 내 최종 거래일 = 진입일 (기간별 종목마다 last 동일하게 맞춤)
                entry = block["last"].max()
                ranked = [[c, int(round(v))] for c, v in zip(block["Code"], block["val"])]
                used_codes.update(block["Code"].tolist())
                rows.append({"d": entry.strftime("%Y-%m-%d"), "r": ranked})
            rows.sort(key=lambda x: x["d"])
            periods[ptype][scope] = rows

    # ── 가격맵 (랭킹 등장 종목만, 수정주가) ──
    # 용량 최적화: 전역 거래일 캘린더를 한 번만 저장하고, 종목은 시작 인덱스(s)와
    # 캘린더 정렬 H/L/C 배열만 저장(거래정지·결측일은 0). 진입가·만기 종가는 정확값
    # 가정이므로 시가(O)는 저장하지 않는다. 종목별 첫 랭킹 등장일부터만 저장(선행 트림).
    pxsub = df[(df["Code"].isin(used_codes)) & (df["Date"] >= START)].copy()
    calendar = sorted(pxsub["Date"].dt.strftime("%Y-%m-%d").unique().tolist())
    cal_idx = {d: i for i, d in enumerate(calendar)}

    # 종목별 첫 등장일(선행 트림 기준)
    first_seen = {}
    for ptype in periods:
        for scope in periods[ptype]:
            for row in periods[ptype][scope]:
                for c, _ in row["r"]:
                    if c not in first_seen or row["d"] < first_seen[c]:
                        first_seen[c] = row["d"]

    stocks = {}
    for code, block in pxsub.groupby("Code"):
        block = block.sort_values("Date")
        dmap = {}
        for _, r in block.iterrows():
            if r["halted"]:
                continue
            dmap[r["Date"].strftime("%Y-%m-%d")] = (
                round(r["adjHigh"]), round(r["adjLow"]), round(r["adjClose"]))
        s = cal_idx.get(first_seen.get(code, calendar[0]), 0)
        h, l, cc = [], [], []
        for i in range(s, len(calendar)):
            v = dmap.get(calendar[i])
            if v is None:
                h.append(0); l.append(0); cc.append(0)  # 거래정지·결측
            else:
                h.append(v[0]); l.append(v[1]); cc.append(v[2])
        stocks[code] = {"n": name_map.get(code, code), "m": mkt_map.get(code, ""),
                        "s": s, "h": h, "l": l, "c": cc}
    return periods, stocks, calendar


def main():
    print("=== 외국인 따라가기 데이터 수집 ===")
    df = load_marcap()
    last_date = df["Date"].max()
    print(f"marcap 최종일: {last_date.date()}")
    uni = build_universe(df)
    cache = load_cache()
    if os.environ.get("FF_SKIP_FETCH") == "1" and cache:
        print(f"네이버 수집 생략(캐시 {len(cache)}종목 사용)")
    else:
        cache = fetch_all_naver(uni, cache)
    periods, stocks, calendar = build(df, uni, cache, last_date.date())

    n_rank_codes = len(stocks)
    for pt in periods:
        for sc in periods[pt]:
            print(f"  {pt}/{sc}: {len(periods[pt][sc])} 기간")
    out = {
        "updated_at": datetime.now(KST).strftime("%Y-%m-%d %H:%M KST"),
        "data_last_date": str(last_date.date()),
        "backtest_start": "2023",
        "cap_top": CAP_TOP,
        "top_k": TOPK,
        "calendar": calendar,
        "periods": periods,
        "stocks": stocks,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    sz = os.path.getsize(OUT) / 1e6
    print(f"저장: {OUT} ({sz:.1f} MB) · 랭킹 종목 {n_rank_codes}개")


if __name__ == "__main__":
    main()
