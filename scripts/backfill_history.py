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
HIGH_CACHE = "backfill_highs.parquet"
REPORTS_CACHE = "backfill_reports.json"

TP_THRESHOLDS = [20, 30, 50, 100]  # 익절 임계값 (%)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}
KST = timezone(timedelta(hours=9))


def fetch_panels(codes, start, end):
    """FDR로 Close + High 동시 수집 (FDR DataReader는 OHLC 모두 반환)."""
    closes, highs = {}, {}
    total = len(codes)
    for i, code in enumerate(codes):
        try:
            df = fdr.DataReader(code, start, end)
            if df is not None and not df.empty:
                if "Close" in df.columns:
                    closes[code] = df["Close"]
                if "High" in df.columns:
                    highs[code] = df["High"]
        except Exception:
            pass
        if (i + 1) % 100 == 0 or (i + 1) == total:
            print(f"  prices {i + 1}/{total}", flush=True)
        time.sleep(0.1)
    cp = pd.DataFrame(closes) if closes else pd.DataFrame()
    hp = pd.DataFrame(highs) if highs else pd.DataFrame()
    cp.sort_index(inplace=True)
    hp.sort_index(inplace=True)
    return cp, hp


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

    # [2] 가격 데이터 (Close + High) 일괄 다운로드
    print("[2/5] 가격 데이터 다운로드...", flush=True)
    if os.path.exists(PRICE_CACHE) and os.path.exists(HIGH_CACHE):
        prices = pd.read_parquet(PRICE_CACHE)
        highs = pd.read_parquet(HIGH_CACHE)
        print(f"  → 캐시 사용: close={prices.shape}, high={highs.shape}\n", flush=True)
    else:
        fetch_start_dt = datetime.strptime(START_MONTH, "%Y-%m") - relativedelta(months=1)
        fetch_start = fetch_start_dt.strftime("%Y-%m-%d")
        fetch_end = today.strftime("%Y-%m-%d")
        prices, highs = fetch_panels(
            universe["Code"].tolist(), fetch_start, fetch_end,
        )
        prices = prices.loc[:, ~prices.columns.duplicated()]
        highs = highs.loc[:, ~highs.columns.duplicated()]
        prices = prices.dropna(how="all").ffill(limit=5)
        highs = highs.dropna(how="all")
        prices.to_parquet(PRICE_CACHE)
        highs.to_parquet(HIGH_CACHE)
        print(f"  → 다운로드 완료: close={prices.shape}, high={highs.shape} (캐시 저장)\n", flush=True)

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

    # forward returns: 보유 종료 시 + 익절(Take-Profit) 시나리오 비교
    for i in range(len(new_history) - 1):
        curr = new_history[i]
        if i + 1 >= len(monthly_data):
            continue
        curr_end = monthly_data[i]["end_dt"]
        next_end = monthly_data[i + 1]["end_dt"]

        # 보유 기간 High 데이터 (entry < t <= exit)
        hold_mask = (highs.index > curr_end) & (highs.index <= next_end)
        highs_period = highs.loc[hold_mask] if not highs.empty else pd.DataFrame()

        # 1) buy-and-hold 수익률
        rets_bh = {"5": [], "10": [], "20": []}
        # 2) TP 시나리오: {tp_pct: {"5": [], "10": [], "20": []}}
        rets_tp = {tp: {"5": [], "10": [], "20": []} for tp in TP_THRESHOLDS}
        hits_tp = {tp: {"5": 0, "10": 0, "20": 0} for tp in TP_THRESHOLDS}

        for idx, s in enumerate(curr.get("stocks", [])[:20]):
            t = s["ticker"]
            if t not in prices.columns:
                continue
            try:
                entry_px = prices.at[curr_end, t]
                exit_px = prices.at[next_end, t]
            except KeyError:
                continue
            if pd.isna(entry_px) or pd.isna(exit_px) or entry_px <= 0:
                continue

            bh_ret = (exit_px / entry_px - 1) * 100

            # 보유 기간 최고가
            if t in highs_period.columns:
                period_high = highs_period[t].max()
            else:
                period_high = None

            # 버킷 분류
            def buckets():
                if idx < 5:  yield "5"
                if idx < 10: yield "10"
                yield "20"

            for b in buckets():
                rets_bh[b].append(bh_ret)

            for tp in TP_THRESHOLDS:
                tp_price = entry_px * (1 + tp / 100)
                hit = period_high is not None and not pd.isna(period_high) and period_high >= tp_price
                tp_ret = float(tp) if hit else bh_ret
                for b in buckets():
                    rets_tp[tp][b].append(tp_ret)
                    if hit:
                        hits_tp[tp][b] += 1

        if rets_bh["5"] or rets_bh["10"] or rets_bh["20"]:
            avg = lambda arr: round(sum(arr) / len(arr), 2) if arr else None
            fr = {
                "next_month": new_history[i + 1]["target_month"],
                "next_period": new_history[i + 1]["period"],
                "top5_avg_pct": avg(rets_bh["5"]),
                "top10_avg_pct": avg(rets_bh["10"]),
                "top20_avg_pct": avg(rets_bh["20"]),
                "top5_n": len(rets_bh["5"]),
                "top10_n": len(rets_bh["10"]),
                "top20_n": len(rets_bh["20"]),
                "take_profit": {},
            }
            for tp in TP_THRESHOLDS:
                key = str(tp)
                fr["take_profit"][key] = {
                    "top5_avg_pct":  avg(rets_tp[tp]["5"]),
                    "top10_avg_pct": avg(rets_tp[tp]["10"]),
                    "top20_avg_pct": avg(rets_tp[tp]["20"]),
                    "top5_hit":  hits_tp[tp]["5"],
                    "top10_hit": hits_tp[tp]["10"],
                    "top20_hit": hits_tp[tp]["20"],
                }
            curr["forward_returns"] = fr

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
