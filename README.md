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
