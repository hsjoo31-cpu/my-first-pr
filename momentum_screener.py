"""
Korean stock momentum screener
- 시총 3000억 이상
- 최근 3개월 수익률 (직전 1주 제외)
- 상위 30개 CSV 저장
- 네이버 금융 리포트 3개월 내 2건 이상 필터
"""

import time
import warnings
import pandas as pd
import requests
import yfinance as yf
import FinanceDataReader as fdr
from bs4 import BeautifulSoup
from datetime import datetime, timedelta

warnings.filterwarnings("ignore")

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    )
}
MARKET_CAP_MIN = 300_000_000_000  # 3000억
TOP_N = 30
REPORT_MIN = 2
CANDIDATE_POOL = 100
NAVER_DELAY = 0.2
YF_BATCH = 100  # yfinance 배치 크기


def yf_suffix(market_id: str) -> str:
    return ".KS" if market_id == "STK" else ".KQ"


def fetch_close_panel(yf_tickers, start_dt, end_dt):
    """yfinance로 종가 패널 받아오기 (배치)"""
    all_close = []
    for i in range(0, len(yf_tickers), YF_BATCH):
        batch = yf_tickers[i:i + YF_BATCH]
        try:
            data = yf.download(
                batch,
                start=start_dt,
                end=end_dt + timedelta(days=1),
                progress=False,
                auto_adjust=True,
                threads=True,
                group_by="ticker",
            )
            if "Close" in data.columns.get_level_values(0):
                close = data["Close"]
            else:
                close = data.xs("Close", level=1, axis=1)
            all_close.append(close)
            print(f"  배치 {i // YF_BATCH + 1}/{(len(yf_tickers) - 1) // YF_BATCH + 1} "
                  f"완료 ({i + len(batch)}/{len(yf_tickers)})")
        except Exception as e:
            print(f"  배치 {i // YF_BATCH + 1} 실패: {e}")
    return pd.concat(all_close, axis=1) if all_close else pd.DataFrame()


def get_report_count(ticker: str, cutoff: datetime) -> int:
    url = (
        "https://finance.naver.com/research/company_list.nhn"
        f"?searchType=itemCode&itemCode={ticker}"
    )
    try:
        resp = requests.get(url, headers=HEADERS, timeout=10)
        resp.encoding = "euc-kr"
        soup = BeautifulSoup(resp.text, "html.parser")
        count = 0
        for td in soup.select("td.date"):
            try:
                report_date = datetime.strptime(td.text.strip(), "%y.%m.%d")
                if report_date >= cutoff:
                    count += 1
            except ValueError:
                continue
        return count
    except Exception:
        return 0


def main():
    print("[1/4] 종목 리스트 + 시가총액 수집 중...")
    listing = fdr.StockListing("KRX")
    listing = listing[listing["MarketId"].isin(["STK", "KSQ"])]
    universe = listing[listing["Marcap"] >= MARKET_CAP_MIN].copy()
    universe["yf_ticker"] = universe["Code"] + universe["MarketId"].apply(yf_suffix)
    print(f"  → 시총 3000억 이상: {len(universe)}개\n")

    # 기간 설정 (벤치마크로 최신 거래일 추정)
    print("[2/4] 기간 설정 중...")
    bench = yf.download("005930.KS", period="6mo", progress=False, auto_adjust=True)
    if bench.empty:
        raise RuntimeError("벤치마크 가격을 받아올 수 없습니다")
    bench_dates = bench.index
    latest_dt = bench_dates[-1].to_pydatetime()
    end_dt = bench_dates[-6].to_pydatetime() if len(bench_dates) >= 6 else latest_dt
    target_start = end_dt - timedelta(days=91)
    start_idx = bench_dates.searchsorted(target_start)
    start_dt = bench_dates[start_idx].to_pydatetime()
    report_cutoff = end_dt - timedelta(days=91)

    print(f"  → 최신 거래일: {latest_dt.date()}")
    print(f"  → 수익률 구간: {start_dt.date()} ~ {end_dt.date()}")
    print(f"  → 리포트 기준: {report_cutoff.date()} 이후\n")

    # 가격 일괄 다운로드
    print(f"[3/4] yfinance 가격 데이터 수집 중 ({len(universe)}개)...")
    close_panel = fetch_close_panel(universe["yf_ticker"].tolist(), start_dt, end_dt)
    print(f"  → 수신 완료: {close_panel.shape[0]}일 × {close_panel.shape[1]}종목\n")

    # 수익률 계산
    returns = {}
    for _, row in universe.iterrows():
        yf_t = row["yf_ticker"]
        if yf_t not in close_panel.columns:
            continue
        s = close_panel[yf_t].dropna()
        if len(s) < 2 or s.iloc[0] <= 0:
            continue
        returns[row["Code"]] = (s.iloc[-1] / s.iloc[0] - 1) * 100

    df_returns = (
        universe[["Code", "Name", "Marcap"]]
        .assign(Return=universe["Code"].map(returns))
        .dropna(subset=["Return"])
        .sort_values("Return", ascending=False)
        .reset_index(drop=True)
    )
    print(f"  → 유효 종목: {len(df_returns)}개\n")

    # 네이버 리포트 필터
    print("[4/4] 애널리스트 리포트 확인 중...")
    passed = []
    for _, row in df_returns.head(CANDIDATE_POOL).iterrows():
        count = get_report_count(row["Code"], report_cutoff)
        mark = "✓" if count >= REPORT_MIN else "·"
        print(f"  {mark} {row['Name']}({row['Code']}) "
              f"수익률 {row['Return']:+.1f}% / 리포트 {count}건")
        if count >= REPORT_MIN:
            passed.append({
                "티커": row["Code"],
                "종목명": row["Name"],
                "수익률(%)": round(row["Return"], 2),
                "시가총액(억)": round(row["Marcap"] / 1e8),
                "리포트수(3개월)": count,
            })
        if len(passed) >= TOP_N:
            break
        time.sleep(NAVER_DELAY)

    result = pd.DataFrame(passed)
    result.index = range(1, len(result) + 1)

    output = "momentum_screener.csv"
    result.to_csv(output, encoding="utf-8-sig", index_label="순위")
    print(f"\n저장 완료 → {output} ({len(result)}개)\n")
    print(result.to_string())


if __name__ == "__main__":
    main()
