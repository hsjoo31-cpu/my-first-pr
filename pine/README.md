# TradingView Pine Script 전략 4종 (BTC 선물, 롱/숏)

TradingView 유료 플랜의 **Strategy Tester**로 실데이터 백테스트를 바로 돌리기 위한
Pine Script v5 전략입니다. 모든 전략은 동일한 비용·사이징 규칙을 씁니다.

| 파일 | 전략 | 메인봉 | 보조봉 | 기본 레버리지 | 거래당 리스크 | 기본 R:R |
|---|---|---|---|---|---|---|
| `A_trend_ema.pine` | EMA 추세추종 | 15m | 1h | 3x | 1.0% | 1:2 |
| `B_breakout.pine` | 변동성 돌파 | 5m | 15m | 3x | 0.75% | 1:1.5 |
| `C_meanrev_rsi_bb.pine` | RSI+볼린저 평균회귀 | 5m | 1h 레짐 | 2x | 0.5% | 1:1 |
| `D_mtf_alignment.pine` | 멀티TF 정렬 추세 | 15m | 1h·4h | 4x | 1.0% | 1:2.5 |

## 적용 방법

1. TradingView 차트에서 심볼을 **`BINANCE:BTCUSDT.P`** (USDT-M 무기한 선물)로 설정.
2. 표의 "메인봉"에 맞춰 차트 타임프레임 변경 (예: A·D는 15m, B·C는 5m).
3. 하단 **Pine Editor** 탭 → 스크립트 내용 붙여넣기 → **Add to chart**.
4. 하단 **Strategy Tester** 탭에서 결과 확인. 톱니바퀴(Settings)로 리스크%·레버리지·R:R 조정.

## 질문하신 지표를 Strategy Tester에서 읽는 법

| 원하는 값 | Strategy Tester 위치 |
|---|---|
| 기대수익률(기간) | **Overview → Net Profit (%)** |
| 월/연 환산 | 백테스트 기간을 확인하고 Net Profit을 개월·연수로 나눔. 또는 날짜범위를 1년으로 설정 |
| **거래/월·거래/년** | **Performance → Total Closed Trades** ÷ 기간(개월·연) |
| 승률 | **Performance → Percent Profitable** |
| 손익비 | **Performance → Ratio Avg Win / Avg Loss** (또는 Profit Factor) |
| MDD | **Performance → Max Drawdown** |
| Sharpe/Sortino | **Performance → Sharpe / Sortino Ratio** |
| 거래당 투입금액 | Settings의 "거래당 리스크 %" → 실제 수량은 손절폭에 맞춰 자동 산정 |

> 정확한 월·연 거래수와 기대수익을 보려면 Strategy Tester의 **날짜 범위(Date Range)**
> 를 최소 1년 이상으로 잡고 보세요. 짧은 구간은 표본이 적어 왜곡됩니다.

## 비용·가정

- **수수료+슬리피지**: 편도 0.06%로 합산 반영 (`commission_value=0.06`).
  바이낸스 taker 0.04% + 슬리피지 0.02% 가정. 실제 수수료율에 맞게 수정하세요.
- **포지션 사이징**: 손절(=ATR×배수)에 닿으면 자본의 `리스크%`만 잃도록 수량 산정.
  단, 명목금액이 `자본×최대레버리지`를 넘지 않도록 상한.
- ⚠️ **청산(liquidation) 미모델링**: TradingView 전략 테스터는 강제청산을 계산하지
  않습니다. 레버리지는 명목금액 상한으로만 반영되므로, 실거래의 청산 위험은 별도로
  보수적으로 가정하세요. 고배율일수록 백테스트보다 실제가 나쁩니다.
- **과최적화 주의**: 파라미터를 과거에 맞춰 너무 깎으면 미래 성과와 괴리됩니다.
  In-sample/Out-of-sample 분할로 검증하세요.

## 실거래 자동화 (다음 단계)

TradingView **Alert → Webhook** 으로 진입/청산 신호를 외부 서버로 보내고, 그 서버가
바이낸스 API로 주문하는 구조가 일반적입니다.

1. 전략에 `alert()` 또는 주문 alert 추가 → Webhook URL 지정
2. 중계 서버(예: Python FastAPI)가 webhook 수신 → ccxt로 바이낸스 선물 주문
3. 반드시 **테스트넷**에서 먼저 검증

> ⚠️ 레버리지 선물은 청산으로 원금 전액 손실이 가능합니다. 본 코드는 학습/검증용입니다.
