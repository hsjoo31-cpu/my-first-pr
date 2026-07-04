# -*- coding: utf-8 -*-
"""
V4: 최종전략(거래대금≤10, V3 매도규칙)에 분할매수 추가
  - 1차: 신호 금요일 종가에 배정자본의 50% 매수
  - 2차: 1차 진입가 -15% 터치 시 나머지 50% 매수 (절반익절 발생 전까지만 유효)
  - 손절 -30% / 절반익절 +45%(보유수량의 절반 매도) / 익절 +90% / 3개월 만기 : 모두 1차 진입가 기준
  - 동일일 우선순위(보수적): 2차매수 → 손절 → 절반익절 → 익절 → 만기
수익률은 배정자본 1단위 기준 (2차 미체결 시 절반은 현금 대기 0%)
"""
import runpy
import os

import pandas as pd

ns = runpy.run_path(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                 "v3_filter_analysis.py"), run_name="reuse")
base_sig, px = ns["base_sig"], ns["px"]
HOLD = pd.DateOffset(months=3)
STOP, DCA, PARTIAL, TP = 0.70, 0.85, 1.45, 1.90

sig = base_sig[base_sig["amt_rank"] <= 10]

trades, open_pos = [], {}
for _, s in sig.iterrows():
    code, entry_date, P = s["Code"], s["lastdate"], s["wclose"]
    if code in open_pos and open_pos[code] >= entry_date:
        continue
    p = px[code]
    fut = p[(p["Date"] > entry_date) & (~p["halted"])]
    limit_date = entry_date + HOLD

    cash = 0.5                    # 대기 중인 2차 자금
    shares = 0.5 / P              # 1차 체결
    pnl_realized = 0.0
    dca_filled = partial_done = False
    exit_date = reason = None
    final_value = None            # 청산 시점 잔여 포지션 가치

    for _, r in fut.iterrows():
        d = r["Date"]
        # 1) 2차 매수 (절반익절 전까지만)
        if not dca_filled and not partial_done and r["adjLow"] <= P * DCA:
            shares += cash / (P * DCA)
            cash = 0.0
            dca_filled = True
        # 2) 손절
        if r["adjLow"] <= P * STOP:
            final_value = shares * P * STOP
            exit_date, reason = d, "손절"
            break
        # 3) 절반익절
        if not partial_done and r["adjHigh"] >= P * PARTIAL:
            pnl_realized += (shares / 2) * P * PARTIAL
            shares /= 2
            partial_done = True
        # 4) 익절
        if r["adjHigh"] >= P * TP:
            final_value = shares * P * TP
            exit_date, reason = d, ("절반익절→익절" if partial_done else "익절")
            break
        # 5) 만기
        if d >= limit_date:
            final_value = shares * r["adjClose"]
            exit_date, reason = d, ("절반익절→만기" if partial_done else "만기")
            break
    if exit_date is None:
        last_row = fut.iloc[-1] if len(fut) else None
        if last_row is None:
            continue
        final_value = shares * last_row["adjClose"]
        exit_date, reason = last_row["Date"], "보유중/중단"

    total = pnl_realized + final_value + cash   # 최종 자본
    ret = total - 1.0                            # 배정자본 1단위 대비
    deployed = 1.0 if dca_filled else 0.5
    ret_deployed = (total - 1.0) / deployed
    trades.append(dict(entry=entry_date, name=s["name"], exit=exit_date, reason=reason,
                       dca=dca_filled, ret=ret, ret_dep=ret_deployed))
    open_pos[code] = exit_date

tr = pd.DataFrame(trades)
print("===== V4 (분할매수) 트레이드 =====")
for _, t in tr.iterrows():
    print(f"{t['entry'].date()}  {t['name']:<12s} → {t['exit'].date()}  {t['reason']:<8s} "
          f"2차 {'체결' if t['dca'] else '미체결'}  배정기준 {t['ret']*100:+7.1f}%  투입기준 {t['ret_dep']*100:+7.1f}%")

r = tr["ret"]
print(f"\n진입 {len(tr)}건 | 2차 체결 {tr['dca'].sum()}건 ({tr['dca'].mean()*100:.0f}%)")
print(f"[배정자본 기준] 승률 {(r>0).mean()*100:.1f}% | 평균 {r.mean()*100:+.2f}% | 누적 {r.sum()*100:+.1f}% | 표준편차 {r.std()*100:.1f}%p")
rd = tr["ret_dep"]
print(f"[투입자본 기준] 평균 {rd.mean()*100:+.2f}% | 누적 {rd.sum()*100:+.1f}%")
print("\n청산유형:")
print(tr.groupby("reason").agg(건수=("ret","count"), 평균배정=("ret","mean"), DCA체결=("dca","sum")).to_string())
tr.to_csv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "trades_result_v4_dca.csv"),
          index=False, encoding="utf-8-sig")
