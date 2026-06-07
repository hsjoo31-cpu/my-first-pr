"""
2020-01부터 현재까지 월별 스크리닝 히스토리 일괄 백필

한계점:
- 시총 필터는 현재 기준 (역사적 시총 데이터 없음 → 생존편향)
- 종목 리스트도 현재 상장 종목만 (상폐 종목 누락)
- 네이버 리포트는 페이지네이션으로 과거까지 수집
"""

import os
import json
import time
import socket
import warnings
import pandas as pd
import requests
import FinanceDataReader as fdr
from bs4 import BeautifulSoup
from datetime import datetime, timedelta, timezone
from dateutil.relativedelta import relativedelta
from concurrent.futures import ThreadPoolExecutor, as_completed

warnings.filterwarnings("ignore")
# FDR 네이버 내부 requests에 timeout이 없어 행이 걸릴 수 있음 → 전역 소켓 타임아웃
socket.setdefaulttimeout(15)

# ── 설정 ─────────────────────────────────────────────────
# 가격 데이터: FinanceDataReader(네이버 일봉) = KRX 정규장 기준(NXT 미포함).
START_MONTH = "2020-01"
MARKET_CAP_MIN = 300_000_000_000
TOP_N = 100
REPORT_MIN = 2
REPORT_WINDOW_DAYS = 91
PRICE_WORKERS = 8
NAVER_WORKERS = 8
NAVER_TIMEOUT = 10
NAVER_MAX_PAGES = 50

HISTORY_PATH = os.path.join("docs", "data", "history.json")
PRICE_CACHE = "backfill_prices.parquet"
REPORTS_CACHE = "backfill_reports.json"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}
KST = timezone(timedelta(hours=9))


def fetch_close_panel(codes, start, end):
    """FinanceDataReader(네이버 일봉, KRX 정규장 기준)로 종가 패널 구성.
    네이버는 동시요청 시 스로틀링/행이 발생할 수 있어 순차 수집한다.
    (전역 socket timeout으로 개별 요청 행을 방지)"""
    closes = {}
    total = len(codes)
    for i, code in enumerate(codes):
        try:
            df = fdr.DataReader(code, start, end)
            if df is not None and not df.empty and "Close" in df.columns:
                closes[code] = df["Close"]
        except Exception:
            pass
        if (i + 1) % 100 == 0 or (i + 1) == total:
            print(f"  prices {i + 1}/{total}", flush=True)
        time.sleep(0.1)
    if not closes:
        return pd.DataFrame()
    panel = pd.DataFrame(closes)
    panel.sort_index(inplace=True)
    return panel


def crawl_naver_dates(ticker, until_date):
    """ticker의 네이버 리포트 발행일을 until_date까지 페이지네이션해서 수집"""
    dates = []
    for page in range(1, NAVER_MAX_PAGES + 1):
        url = (
            "https://finance.naver.com/research/company_list.nhn"
            f"?searchType=itemCode&itemCode={ticker}&page={page}"
        )
        try:
            resp = requests.get(url, headers=HEADERS, timeout=NAVER_TIMEOUT)
            resp.encoding = "euc-kr"
            soup = BeautifulSoup(resp.text, "html.parser")
            page_dates = []
            for td in soup.select("td.date"):
                try:
                    d = datetime.strptime(td.text.strip(), "%y.%m.%d")
                    page_dates.append(d)
                except ValueError:
                    continue
            if not page_dates:
                break
            dates.extend(page_dates)
            if min(page_dates) < until_date:
                break
        except Exception:
            break
    return dates


def month_range(start_str, end_str):
    start = datetime.strptime(start_str, "%Y-%m")
    end = datetime.strptime(end_str, "%Y-%m")
    cur = start
    while cur <= end:
        yield cur.strftime("%Y-%m")
        cur += relativedelta(months=1)


def main():
    today = datetime.now(KST)
    print(f"실행 시각: {today.isoformat()}\n", flush=True)

    # [1] Universe
    print("[1/5] Universe 구성 (현재 시총 기준)...", flush=True)
    listing = fdr.StockListing("KRX")
    listing = listing[listing["MarketId"].isin(["STK", "KSQ"])]
    universe = listing[listing["Marcap"] >= MARKET_CAP_MIN].copy()
    universe_lookup = universe.set_index("Code")
    print(f"  → {len(universe)}개 종목\n", flush=True)

    # 백필할 월 범위 (현재까지)
    this_month_first = today.replace(day=1).replace(tzinfo=None)
    end_month_dt = this_month_first - relativedelta(months=1)
    end_month = end_month_dt.strftime("%Y-%m")
    months = list(month_range(START_MONTH, end_month))
    print(f"  백필 범위: {months[0]} ~ {months[-1]} ({len(months)}개월)\n", flush=True)

    # [2] 가격 데이터 일괄 다운로드
    print("[2/5] 가격 데이터 다운로드...", flush=True)
    if os.path.exists(PRICE_CACHE):
        prices = pd.read_parquet(PRICE_CACHE)
        print(f"  → 캐시 사용: {prices.shape}\n", flush=True)
    else:
        # START_MONTH 직전 월말 데이터 확보를 위해 1개월 여유
        fetch_start_dt = datetime.strptime(START_MONTH, "%Y-%m") - relativedelta(months=1)
        fetch_start = fetch_start_dt.strftime("%Y-%m-%d")
        fetch_end = today.strftime("%Y-%m-%d")
        prices = fetch_close_panel(
            universe["Code"].tolist(), fetch_start, fetch_end,
        )
        prices = prices.loc[:, ~prices.columns.duplicated()]
        prices = prices.dropna(how="all").ffill(limit=5)
        prices.to_parquet(PRICE_CACHE)
        print(f"  → 다운로드 완료: {prices.shape} (캐시 저장)\n", flush=True)

    # [3] 월별 수익률 계산 → 후보 종목 모음
    print("[3/5] 월별 상위 종목 계산...", flush=True)
    monthly_data = []  # {ym, start_dt, end_dt, top: pd.Series}
    candidate_tickers = set()

    for ym in months:
        ym_dt = datetime.strptime(ym, "%Y-%m")
        next_ym_dt = ym_dt + relativedelta(months=1)

        month_mask = (prices.index >= ym_dt) & (prices.index < next_ym_dt)
        prices_month = prices.loc[month_mask]
        if prices_month.empty:
            print(f"  {ym}: 데이터 없음 (skip)", flush=True)
            continue
        end_dt = prices_month.index[-1]

        prior = prices.loc[prices.index < ym_dt]
        if prior.empty:
            print(f"  {ym}: 직전 월말 데이터 없음 (skip)", flush=True)
            continue
        start_dt = prior.index[-1]

        returns = ((prices.loc[end_dt] / prices.loc[start_dt]) - 1) * 100
        returns = returns.dropna().sort_values(ascending=False)
        top = returns.head(TOP_N)

        monthly_data.append({
            "ym": ym,
            "start_dt": start_dt,
            "end_dt": end_dt,
            "top": top,
        })
        candidate_tickers.update(top.index)
        print(f"  {ym}: 후보 {len(top)}개 ({start_dt.date()} → {end_dt.date()})", flush=True)

    print(f"\n  → 전체 후보 union: {len(candidate_tickers)}개\n", flush=True)

    # [4] 네이버 리포트 일괄 크롤링 (후보 종목만)
    print(f"[4/5] 네이버 리포트 크롤링 (후보 {len(candidate_tickers)}개)...", flush=True)
    reports_cache = {}
    if os.path.exists(REPORTS_CACHE):
        with open(REPORTS_CACHE, "r", encoding="utf-8") as f:
            raw = json.load(f)
        reports_cache = {k: [datetime.fromisoformat(d) for d in v]
                         for k, v in raw.items()}
        print(f"  → 캐시 사용: {len(reports_cache)}개", flush=True)

    missing = [t for t in candidate_tickers if t not in reports_cache]
    if missing:
        print(f"  → 신규 크롤링: {len(missing)}개", flush=True)
        until = datetime.strptime(START_MONTH, "%Y-%m") - timedelta(days=120)
        done = 0
        with ThreadPoolExecutor(max_workers=NAVER_WORKERS) as ex:
            futs = {ex.submit(crawl_naver_dates, t, until): t for t in missing}
            for fut in as_completed(futs):
                t = futs[fut]
                try:
                    reports_cache[t] = fut.result()
                except Exception:
                    reports_cache[t] = []
                done += 1
                if done % 25 == 0 or done == len(missing):
                    print(f"    {done}/{len(missing)}", flush=True)
        # save cache
        with open(REPORTS_CACHE, "w", encoding="utf-8") as f:
            json.dump(
                {k: [d.isoformat() for d in v] for k, v in reports_cache.items()},
                f, ensure_ascii=False,
            )
        print(f"  → 캐시 저장 완료\n", flush=True)
    else:
        print("  → 신규 크롤링 없음\n", flush=True)

    # [5] 월별 entry 빌드 + forward returns 계산
    print("[5/5] history.json 빌드...", flush=True)
    new_history = []
    for entry in monthly_data:
        ym = entry["ym"]
        end_dt = entry["end_dt"]
        start_dt = entry["start_dt"]
        cutoff = end_dt - timedelta(days=REPORT_WINDOW_DAYS)

        passed = []
        for ticker, ret in entry["top"].items():
            if ticker not in universe_lookup.index:
                continue
            dates = reports_cache.get(ticker, [])
            count = sum(1 for d in dates if cutoff <= d <= end_dt)
            if count >= REPORT_MIN:
                row = universe_lookup.loc[ticker]
                passed.append({
                    "rank": len(passed) + 1,
                    "ticker": ticker,
                    "name": row["Name"],
                    "market": row["Market"],
                    "return_pct": round(float(ret), 2),
                    "marcap_eok": round(float(row["Marcap"]) / 1e8),
                    "report_count": count,
                })

        new_history.append({
            "target_month": ym,
            "updated_at": today.isoformat(),
            "period": {
                "start": start_dt.strftime("%Y-%m-%d"),
                "end": end_dt.strftime("%Y-%m-%d"),
            },
            "passed_count": len(passed),
            "stocks": passed,
        })

    # forward returns: 각 월의 top5/top10/top20을 다음 월말까지 보유 시 평균
    for i in range(len(new_history) - 1):
        curr = new_history[i]
        if i + 1 >= len(monthly_data):
            continue
        curr_end = monthly_data[i]["end_dt"]
        next_end = monthly_data[i + 1]["end_dt"]
        rets5, rets10, rets20 = [], [], []
        for idx, s in enumerate(curr.get("stocks", [])[:20]):
            t = s["ticker"]
            if t not in prices.columns:
                continue
            try:
                px_a = prices.at[curr_end, t]
                px_b = prices.at[next_end, t]
            except KeyError:
                continue
            if pd.isna(px_a) or pd.isna(px_b) or px_a <= 0:
                continue
            r = (px_b / px_a - 1) * 100
            if idx < 5:
                rets5.append(r)
            if idx < 10:
                rets10.append(r)
            rets20.append(r)
        if rets5 or rets10 or rets20:
            curr["forward_returns"] = {
                "next_month": new_history[i + 1]["target_month"],
                "next_period": new_history[i + 1]["period"],
                "top5_avg_pct": round(sum(rets5) / len(rets5), 2) if rets5 else None,
                "top10_avg_pct": round(sum(rets10) / len(rets10), 2) if rets10 else None,
                "top20_avg_pct": round(sum(rets20) / len(rets20), 2) if rets20 else None,
                "top5_n": len(rets5),
                "top10_n": len(rets10),
                "top20_n": len(rets20),
            }

    # 정렬 (최신순) 및 저장
    new_history.sort(key=lambda h: h["target_month"], reverse=True)
    os.makedirs(os.path.dirname(HISTORY_PATH), exist_ok=True)
    with open(HISTORY_PATH, "w", encoding="utf-8") as f:
        json.dump(new_history, f, ensure_ascii=False, indent=2)

    print(f"\n저장 완료 → {HISTORY_PATH} ({len(new_history)}개월)", flush=True)
    # 간단 통계
    with_fwd = sum(1 for h in new_history if "forward_returns" in h)
    print(f"  forward_returns 보유: {with_fwd}/{len(new_history)}개월", flush=True)
    for h in new_history[:5]:
        fr = h.get("forward_returns", {})
        line = f"  {h['target_month']}: 통과 {h['passed_count']}개"
        if fr:
            line += (f" / 다음달 top10={fr.get('top10_avg_pct')}% "
                     f"top20={fr.get('top20_avg_pct')}%")
        print(line, flush=True)


if __name__ == "__main__":
    main()
