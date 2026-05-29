# my-first-pr

학습용 저장소 — 간단한 계산기와 국내 주식 모멘텀 스크리너 프로젝트.

## 1. Calculator

기본 사칙연산 함수.

```
pytest test_calculator.py
```

## 2. 모멘텀 스크리너

`momentum_screener.py` — 시총 3000억 이상 종목 중 3개월 수익률 상위 30개를 선정해 CSV로 저장. 네이버 금융 리포트 발행 빈도로 추가 필터링.

```
pip install -r requirements.txt
python momentum_screener.py
```

## 3. 백테스트

`backtest.py` — 위 전략을 2020년부터 시뮬레이션하여 Top N별 성과 비교.

```
python backtest.py
```

## 4. 자동 스크리너 사이트

매월 첫 거래일에 GitHub Actions가 자동으로 스크리닝을 돌려 `docs/data/results.json` 을 업데이트하고, GitHub Pages에서 결과를 표시.

- 스크립트: `scripts/monthly_screener.py`
- 사이트: `docs/`
- 워크플로우: `.github/workflows/screener.yml`

### Pages 활성화 (저장소 Settings)

Settings → Pages → Source: `main` branch, `/docs` folder → Save

## 5. 비트코인 선물 변동성 돌파 백테스트

`vol_breakout_backtest.py` — 바이낸스 USDT-M 선물(`BTC/USDT`)의 분봉 변동성 돌파
전략을 백테스트. 각 봉의 목표가 = 시가 + k × (직전 봉 고가−저가), 봉 내 고가가
목표가를 돌파하면 롱 진입·봉 마감 청산. k = 0.3/0.5/0.7/1.0 비교, 수수료·슬리피지 반영.

```
pip install -r requirements.txt
python vol_breakout_backtest.py
```

> ⚠️ 레버리지 선물은 청산 위험이 큽니다. 학습/검증용 백테스트이며, 실거래 전
> 반드시 테스트넷에서 검증하세요. 데이터 수집에는 바이낸스 API 접속이 필요합니다.
