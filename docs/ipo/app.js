"use strict";

// ──────────────────────────────────────────
// 상태
// ──────────────────────────────────────────
let allStocks = [];

const params = {
  reference: "listing_open", // "listing_open" | "ipo_price"
  n: 20,                     // 매수 하락률 (%)
  losscut: 10,               // 손절 기준 (%, 0 = 없음)
  holdingMonths: 3,          // 최대 보유기간 (개월)
  target: 20,                // 목표수익률 (%)
  buyWindow: 0,              // 매수 기회 기간 (상장 후 N개월, 0 = 무제한)
};

// ──────────────────────────────────────────
// 초기화
// ──────────────────────────────────────────
async function init() {
  bindControls();
  await loadData();
}

async function loadData() {
  setBody('<tr><td colspan="11" class="empty">데이터 로딩 중…</td></tr>');
  try {
    const res = await fetch("../data/ipo_data.json?ts=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    // 거래정지·결측일(OHLC에 0 포함)은 체결 불가 → 방어적으로 제거
    allStocks = (data.stocks || []).map((s) => {
      const prices = (s.prices || []).filter(
        (r) => r.o > 0 && r.h > 0 && r.l > 0 && r.c > 0
      );
      return {
        ...s,
        prices,
        listing_open: prices.length ? prices[0].o : s.listing_open,
      };
    }).filter((s) => s.prices.length > 0);
    document.getElementById("updated-at").textContent = data.updated_at || "—";
    document.getElementById("total-count").textContent = allStocks.length + "개";
    render();
    scheduleRecommendations();
  } catch (e) {
    setBody(`<tr><td colspan="11" class="empty">데이터를 불러올 수 없습니다: ${e.message}</td></tr>`);
  }
}

// ──────────────────────────────────────────
// 컨트롤 바인딩
// ──────────────────────────────────────────
function bindControls() {
  // 기준가 탭
  bindTabs("ref-tabs", (val) => {
    params.reference = val;
    render();
  });

  // 매수 하락률 슬라이더
  const slider = document.getElementById("n-slider");
  const nVal = document.getElementById("n-val");
  slider.addEventListener("input", () => {
    params.n = +slider.value;
    nVal.textContent = slider.value;
    render();
  });

  // 손절 기준
  const losscutInput = document.getElementById("losscut-input");
  losscutInput.addEventListener("change", () => {
    // 5% 단위로 반올림 후 0~50 클램프
    const v = Math.round((+losscutInput.value || 0) / LC_STEP) * LC_STEP;
    params.losscut = Math.max(0, Math.min(50, v));
    losscutInput.value = params.losscut;
    render();
  });

  // 최대 보유기간 탭
  bindTabs("holding-tabs", (val) => {
    params.holdingMonths = +val;
    render();
  });

  // 목표수익률 탭
  bindTabs("target-tabs", (val) => {
    params.target = +val;
    render();
  });

  // 매수 기회 기간 (상장 후 N개월)
  const buyWindowInput = document.getElementById("buywindow-input");
  buyWindowInput.addEventListener("change", () => {
    params.buyWindow = Math.max(0, Math.min(48, +buyWindowInput.value || 0));
    buyWindowInput.value = params.buyWindow;
    render();
    scheduleRecommendations(); // 스크리닝 기간이 바뀌면 추천도 재탐색
  });
}

function bindTabs(groupId, onChange) {
  const group = document.getElementById(groupId);
  group.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.classList.contains("disabled")) return;
      group.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(btn.dataset.value);
    });
  });
}

// ──────────────────────────────────────────
// 백테스팅 핵심 로직
// ──────────────────────────────────────────

/**
 * addMonths("2023-07-15", 3) → "2023-10-15"
 * 월 말일 초과 시 자동 조정. Date.UTC로 계산해 사용자 시간대와 무관하게
 * 동일한 결과를 보장한다(로컬 Date + toISOString은 KST에서 하루 밀림).
 */
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const base = new Date(Date.UTC(y, m - 1 + months, d));
  return base.toISOString().slice(0, 10);
}

function daysBetween(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}

function fmt(n, digits = 1) {
  if (n == null) return "—";
  const s = n.toFixed(digits);
  return (n >= 0 ? "+" : "") + s + "%";
}

function fmtPrice(n) {
  if (!n) return "—";
  return n.toLocaleString("ko-KR") + "원";
}

/**
 * 단일 종목 백테스트
 * @returns {object} result
 *   status: "no_signal" | "ongoing" | "target" | "losscut" | "expired" | "ambiguous"
 */
function backtestStock(stock, p = params) {
  const refPrice =
    p.reference === "ipo_price" ? stock.ipo_price : stock.listing_open;

  if (!refPrice) return { status: "no_signal", reason: "기준가 없음" };

  const buyTrigger = refPrice * (1 - p.n / 100);
  const prices = stock.prices; // [{d,o,h,l,c}, ...]

  // 매수 기회 기간: 상장일로부터 N개월 이내에 트리거가 발생해야 후보로 인정
  const windowCutoff =
    p.buyWindow > 0 ? addMonths(stock.ipo_date, p.buyWindow) : null;

  // ── 매수일 탐색 ──
  let buyIdx = -1;
  for (let i = 0; i < prices.length; i++) {
    // 매수 기회 기간을 벗어나면 탐색 중단 → 후보 제외
    if (windowCutoff && prices[i].d > windowCutoff) break;
    if (prices[i].l <= buyTrigger) {
      buyIdx = i;
      break;
    }
  }

  if (buyIdx === -1) return { status: "no_signal" };

  const buyPrice = buyTrigger;
  const buyDate = prices[buyIdx].d;
  const sellCalendarDate = addMonths(buyDate, p.holdingMonths);

  const targetSellPrice =
    p.target > 0 ? buyPrice * (1 + p.target / 100) : Infinity;
  const losscutThreshold =
    p.losscut > 0 ? buyPrice * (1 - p.losscut / 100) : -Infinity;

  // ── 매수일부터 시뮬레이션 ──
  for (let i = buyIdx; i < prices.length; i++) {
    const day = prices[i];

    // 보유기간 만료 체크: 이 날의 날짜가 만료일 이상이면 시초가에 매도
    // (buyIdx 당일은 만료 체크 제외 — 방금 산 날이므로)
    if (i > buyIdx && day.d >= sellCalendarDate) {
      const sellPct = ((day.o - buyPrice) / buyPrice) * 100;
      return {
        status: "expired",
        buyDate,
        sellDate: day.d,
        daysHeld: daysBetween(buyDate, day.d),
        returnPct: sellPct,
        refPrice,
        buyPrice,
        sellPrice: day.o,
      };
    }

    // 목표 / 손절 동시 발생 → 요확인
    const targetHit = day.h >= targetSellPrice;
    const losscutHit =
      p.losscut > 0 && day.c <= losscutThreshold;

    if (targetHit && losscutHit) {
      return {
        status: "ambiguous",
        buyDate,
        sellDate: day.d,
        daysHeld: daysBetween(buyDate, day.d),
        returnPct: null,
        refPrice,
        buyPrice,
        sellPrice: null,
      };
    }

    if (targetHit) {
      return {
        status: "target",
        buyDate,
        sellDate: day.d,
        daysHeld: daysBetween(buyDate, day.d),
        returnPct: p.target, // 목표가에 정확히 매도
        refPrice,
        buyPrice,
        sellPrice: Math.round(targetSellPrice),
      };
    }

    if (losscutHit) {
      const sellPct = ((day.c - buyPrice) / buyPrice) * 100;
      return {
        status: "losscut",
        buyDate,
        sellDate: day.d,
        daysHeld: daysBetween(buyDate, day.d),
        returnPct: sellPct,
        refPrice,
        buyPrice,
        sellPrice: day.c,
      };
    }
  }

  // 데이터 부족 (아직 보유 중)
  return { status: "ongoing", buyDate, refPrice, buyPrice };
}

// ──────────────────────────────────────────
// 렌더링
// ──────────────────────────────────────────
function render() {
  // 공모가 탭 비활성화 처리
  const ipoTab = document
    .getElementById("ref-tabs")
    .querySelector('[data-value="ipo_price"]');
  const hasIpoPrice = allStocks.some((s) => s.ipo_price);
  ipoTab.classList.toggle("disabled", !hasIpoPrice);
  if (!hasIpoPrice && params.reference === "ipo_price") {
    params.reference = "listing_open";
    document
      .getElementById("ref-tabs")
      .querySelector('[data-value="listing_open"]')
      .classList.add("active");
    ipoTab.classList.remove("active");
  }

  const results = allStocks.map((stock) => ({
    stock,
    result: backtestStock(stock),
  }));

  // 통계 계산 (신호 발생 & 거래 완료된 건)
  const signaled = results.filter((r) => r.result.status !== "no_signal");
  const completed = signaled.filter(
    (r) =>
      r.result.status === "target" ||
      r.result.status === "losscut" ||
      r.result.status === "expired"
  );
  const wins = completed.filter((r) => r.result.status === "target");
  const losses = completed.filter((r) => r.result.status === "losscut");
  const returns = completed
    .map((r) => r.result.returnPct)
    .filter((v) => v != null);
  const avgReturn =
    returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : null;

  document.getElementById("signal-count").textContent =
    signaled.length + "개";
  document.getElementById("win-count").textContent = wins.length + "개";
  document.getElementById("win-rate").textContent =
    completed.length > 0
      ? ((wins.length / completed.length) * 100).toFixed(1) + "%"
      : "—";
  const avgEl = document.getElementById("avg-return");
  avgEl.textContent = avgReturn != null ? fmt(avgReturn) : "—";
  avgEl.className = "value " + (avgReturn >= 0 ? "positive" : "negative");
  document.getElementById("losscut-rate").textContent =
    completed.length > 0
      ? ((losses.length / completed.length) * 100).toFixed(1) + "%"
      : "—";

  const note = document.getElementById("results-note");
  note.textContent =
    signaled.length > 0
      ? `신호 ${signaled.length}건 중 완료 ${completed.length}건 · 진행중 ${
          signaled.length - completed.length - results.filter(r=>r.result.status==='ambiguous').length
        }건`
      : "";

  // 테이블 렌더링 (신호 없는 종목도 표시, 정렬: 매수일 → 상장일)
  const sorted = [...results].sort((a, b) => {
    const as = a.result.status === "no_signal" ? 1 : 0;
    const bs = b.result.status === "no_signal" ? 1 : 0;
    if (as !== bs) return as - bs;
    const da = a.result.buyDate || a.stock.ipo_date;
    const db = b.result.buyDate || b.stock.ipo_date;
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const rows = sorted.map(({ stock, result }) => buildRow(stock, result)).join("");
  setBody(rows || '<tr><td colspan="11" class="empty">해당 조건의 결과 없음</td></tr>');
}

function buildRow(stock, r) {
  const refLabel =
    params.reference === "ipo_price" ? "공모가" : "시초가";

  const statusBadge = {
    target:    `<span class="badge badge-target">✅ 목표달성</span>`,
    losscut:   `<span class="badge badge-losscut">❌ 손절</span>`,
    expired:   `<span class="badge badge-expired">⏱ 기간만료</span>`,
    ambiguous: `<span class="badge badge-ambig">⚠️ 요확인</span>`,
    ongoing:   `<span class="badge badge-ongoing">📌 진행중</span>`,
    no_signal: `<span class="badge badge-nosig">— 신호없음</span>`,
  }[r.status] || "";

  const returnCell =
    r.returnPct != null
      ? `<td class="num ${r.returnPct >= 0 ? "positive" : "negative"}">${fmt(r.returnPct)}</td>`
      : `<td class="num warning">⚠️ 요확인</td>`;

  return `<tr>
    <td><strong>${esc(stock.name)}</strong></td>
    <td><span class="market-tag">${esc(stock.market)}</span></td>
    <td class="num">${stock.ipo_date}</td>
    <td class="num">${r.buyDate || "—"}</td>
    <td class="num">${r.sellDate || "—"}</td>
    <td class="num">${r.daysHeld != null ? r.daysHeld + "일" : "—"}</td>
    <td class="num">${fmtPrice(r.refPrice)}<br/><small style="color:var(--text-dim);font-size:10px">${refLabel}</small></td>
    <td class="num">${fmtPrice(r.buyPrice ? Math.round(r.buyPrice) : null)}</td>
    <td class="num">${fmtPrice(r.sellPrice)}</td>
    ${returnCell}
    <td>${statusBadge}</td>
  </tr>`;
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function setBody(html) {
  document.getElementById("results-body").innerHTML = html;
}

// ──────────────────────────────────────────
// 추천 전략 — 전체 조합 그리드 서치
// ──────────────────────────────────────────
const GRID = {
  reference: ["listing_open", "ipo_price"],
  n: Array.from({ length: 21 }, (_, i) => i * 5),       // 0 ~ 100 (5% 단위)
  losscut: Array.from({ length: 11 }, (_, i) => i * 5), // 0 ~ 50 (5% 단위)
  holdingMonths: [1, 2, 3],
  target: [20, 30, 40, 50],
};
const N_STEP = 5;  // 매수 하락률 단위(슬라이더·그리드 공통)
const LC_STEP = 5; // 손절 기준 단위(입력란·그리드 공통)
const MIN_COMPLETED = 10; // 목표달성률·평균수익률 추천 최소 표본(완료 거래)
const TIE_EPS = 1e-9;

let recoTimer = null;
function scheduleRecommendations() {
  const cards = document.getElementById("reco-cards");
  const status = document.getElementById("reco-status");
  status.textContent = "계산 중…";
  cards.innerHTML = '<div class="reco-card placeholder">모든 조합 탐색 중…</div>';
  clearTimeout(recoTimer);
  // setTimeout으로 "계산 중" 표시를 먼저 그리게 함
  recoTimer = setTimeout(() => {
    const t0 = performance.now();
    const result = runGridSearch();   // 보유기간별 평균/누적 TOP5
    attachPeakHoldings(result);       // 각 추천의 동시 최대보유 종목수
    const ms = Math.round(performance.now() - t0);
    renderRecommendations(result);
    status.textContent = `${(GRID.reference.length * GRID.n.length * GRID.losscut.length * GRID.holdingMonths.length * GRID.target.length).toLocaleString()}개 조합 · ${ms}ms`;
  }, 30);
}

const TOP_N_RECO = 5; // 각 순위 목록 상위 N개

function runGridSearch() {
  const stocks = allStocks;
  const buyWindow = params.buyWindow;
  const hasIpo = stocks.some((s) => s.ipo_price);

  // 보유기간(1·2·3개월)별로 분리.
  // 각 보유기간 안에서 핵심전략(기준가·하락률·목표)별 최적 손절만 유지
  // (손절만 다른 사실상 동일 전략 중복 방지). 평균용·누적용 각각.
  const acc = {
    1: { avg: new Map(), cum: new Map() },
    2: { avg: new Map(), cum: new Map() },
    3: { avg: new Map(), cum: new Map() },
  };

  for (const reference of GRID.reference) {
    if (reference === "ipo_price" && !hasIpo) continue;

    for (const n of GRID.n) {
      // 1) (reference, n)에 대한 매수 시점을 종목별로 1회만 계산
      const buys = [];
      for (let si = 0; si < stocks.length; si++) {
        const stock = stocks[si];
        const refPrice =
          reference === "ipo_price" ? stock.ipo_price : stock.listing_open;
        if (!refPrice) continue;
        const buyTrigger = refPrice * (1 - n / 100);
        const prices = stock.prices;
        const windowCutoff =
          buyWindow > 0 ? addMonths(stock.ipo_date, buyWindow) : null;
        let buyIdx = -1;
        for (let i = 0; i < prices.length; i++) {
          if (windowCutoff && prices[i].d > windowCutoff) break;
          if (prices[i].l <= buyTrigger) {
            buyIdx = i;
            break;
          }
        }
        if (buyIdx === -1) continue;
        buys.push({ prices, buyIdx, buyDate: prices[buyIdx].d, buyPrice: buyTrigger });
      }
      if (buys.length === 0) continue;

      for (const holdingMonths of GRID.holdingMonths) {
        // 2) holding별 만료 인덱스 사전 계산
        for (let bi = 0; bi < buys.length; bi++) {
          const b = buys[bi];
          const sellCalendarDate = addMonths(b.buyDate, holdingMonths);
          let expiryIdx = b.prices.length; // 못 찾으면 데이터 끝(보유중)
          for (let i = b.buyIdx + 1; i < b.prices.length; i++) {
            if (b.prices[i].d >= sellCalendarDate) {
              expiryIdx = i;
              break;
            }
          }
          b.expiryIdx = expiryIdx;
        }

        for (const target of GRID.target) {
          for (const losscut of GRID.losscut) {
            let wins = 0,
              completed = 0,
              retSum = 0;
            const signals = buys.length;

            for (let bi = 0; bi < buys.length; bi++) {
              const b = buys[bi];
              const prices = b.prices;
              const buyPrice = b.buyPrice;
              const targetSellPrice = buyPrice * (1 + target / 100);
              const losscutThreshold =
                losscut > 0 ? buyPrice * (1 - losscut / 100) : -Infinity;
              const end = b.expiryIdx;

              let exited = false;
              for (let i = b.buyIdx; i < end; i++) {
                const day = prices[i];
                const targetHit = day.h >= targetSellPrice;
                const losscutHit = losscut > 0 && day.c <= losscutThreshold;
                if (targetHit && losscutHit) {
                  exited = true; // 요확인 → 완료에서 제외
                  break;
                }
                if (targetHit) {
                  wins++;
                  completed++;
                  retSum += target;
                  exited = true;
                  break;
                }
                if (losscutHit) {
                  completed++;
                  retSum += ((day.c - buyPrice) / buyPrice) * 100;
                  exited = true;
                  break;
                }
              }
              if (!exited) {
                // 만료일 도달 → 다음 거래일(=expiryIdx) 시초가 매도
                if (end < prices.length) {
                  completed++;
                  retSum += ((prices[end].o - buyPrice) / buyPrice) * 100;
                }
                // end == prices.length 이면 아직 보유중(완료 아님)
              }
            }

            const avgReturn = completed > 0 ? retSum / completed : null;
            if (completed < MIN_COMPLETED || avgReturn == null) continue;

            const combo = {
              reference, n, losscut, holdingMonths, target,
              signals, wins, completed, avgReturn, sum: retSum,
            };
            const core = `${reference}|${n}|${target}`;
            const slot = acc[holdingMonths];
            const a = slot.avg.get(core);
            if (!a || avgReturn > a.avgReturn) slot.avg.set(core, combo);
            const cu = slot.cum.get(core);
            if (!cu || retSum > cu.sum) slot.cum.set(core, combo);
          }
        }
      }
    }
  }

  // 보유기간별: 평균수익률 / 누적수익률 각각 상위 N개
  const result = {};
  for (const h of [1, 2, 3]) {
    result[h] = {
      avg: [...acc[h].avg.values()].sort((a, b) => b.avgReturn - a.avgReturn).slice(0, TOP_N_RECO),
      cum: [...acc[h].cum.values()].sort((a, b) => b.sum - a.sum).slice(0, TOP_N_RECO),
    };
  }
  return result;
}

function refLabelOf(ref) {
  return ref === "ipo_price" ? "공모가" : "시초가";
}

// 해당 전략으로 매매했을 때 '동시에 보유한 최대 종목 수'(peak)
// 각 종목의 보유구간 [매수일, 매도일](진행중이면 데이터 끝)의 최대 겹침
function peakConcurrentHoldings(p) {
  const intervals = [];
  for (const s of allStocks) {
    const r = backtestStock(s, p);
    if (r.status === "no_signal" || !r.buyDate) continue;
    const sell = r.sellDate || s.prices[s.prices.length - 1].d;
    intervals.push([r.buyDate, sell]);
  }
  let peak = 0;
  for (const [b0] of intervals) {
    let cnt = 0;
    for (const [b, s] of intervals) if (b <= b0 && b0 <= s) cnt++;
    if (cnt > peak) peak = cnt;
  }
  return peak;
}

// 화면에 표시되는 모든 추천 조합에 동시 최대보유 종목수 부착 (중복은 캐시)
function attachPeakHoldings(result) {
  const bw = params.buyWindow;
  const cache = new Map();
  const keyOf = c => `${c.reference}|${c.n}|${c.losscut}|${c.holdingMonths}|${c.target}`;
  for (const h of [1, 2, 3]) {
    for (const list of [result[h].avg, result[h].cum]) {
      for (const c of list) {
        const k = keyOf(c);
        if (!cache.has(k)) {
          cache.set(k, peakConcurrentHoldings({
            reference: c.reference, n: c.n, losscut: c.losscut,
            holdingMonths: c.holdingMonths, target: c.target, buyWindow: bw,
          }));
        }
        c.peakHoldings = cache.get(k);
      }
    }
  }
}

function recoRow(rank, c, metric) {
  const val = metric === "cum" ? c.sum : c.avgReturn;
  const cls = val >= 0 ? "positive" : "negative";
  const lossLabel = c.losscut > 0 ? `-${c.losscut}%` : "없음";
  const strat = JSON.stringify({
    reference: c.reference, n: c.n, losscut: c.losscut,
    holdingMonths: c.holdingMonths, target: c.target,
  });
  return `<div class="reco-row">
    <div class="reco-row-head">
      <span class="reco-rank">${rank}</span>
      <span class="reco-row-val ${cls}">${fmt(val)}</span>
      <button class="reco-apply" data-strategy='${strat}'>적용</button>
    </div>
    <div class="reco-row-params">${refLabelOf(c.reference)} · 하락 -${c.n}% · 손절 ${lossLabel} · 목표 +${c.target}%</div>
    <div class="reco-row-note">완료 ${c.completed} · 달성 ${c.wins} · 동시최대 ${c.peakHoldings}종목</div>
  </div>`;
}

function renderColList(list, metric) {
  if (!list.length) return `<div class="reco-empty">데이터 없음</div>`;
  return list.map((c, i) => recoRow(i + 1, c, metric)).join("");
}

function renderRecommendations(result) {
  const container = document.getElementById("reco-cards");
  const anyData = [1, 2, 3].some(h => result[h].avg.length || result[h].cum.length);
  if (!anyData) {
    container.innerHTML = `<div class="reco-card placeholder">조건을 만족하는 전략이 없습니다 (완료 거래 ${MIN_COMPLETED}건 이상 필요)</div>`;
    return;
  }
  container.innerHTML = [1, 2, 3].map(h => `
    <div class="reco-block">
      <h3 class="reco-block-title">${h}개월 보유</h3>
      <div class="reco-cols">
        <div class="reco-col">
          <div class="reco-col-title">📊 평균 수익률 TOP 5</div>
          ${renderColList(result[h].avg, "avg")}
        </div>
        <div class="reco-col">
          <div class="reco-col-title">💰 누적 수익률 TOP 5 <small>(단순 합산)</small></div>
          ${renderColList(result[h].cum, "cum")}
        </div>
      </div>
    </div>
  `).join("");

  container.querySelectorAll(".reco-apply").forEach((btn) => {
    btn.addEventListener("click", () => applyStrategy(JSON.parse(btn.dataset.strategy)));
  });
}

function applyStrategy(s) {
  params.reference = s.reference;
  params.n = s.n;
  params.losscut = s.losscut;
  params.holdingMonths = s.holdingMonths;
  params.target = s.target;

  // UI 컨트롤 동기화
  setTabActive("ref-tabs", s.reference);
  setTabActive("holding-tabs", String(s.holdingMonths));
  setTabActive("target-tabs", String(s.target));
  const slider = document.getElementById("n-slider");
  slider.value = s.n;
  document.getElementById("n-val").textContent = s.n;
  document.getElementById("losscut-input").value = s.losscut;

  render();
  // 화면 상단(컨트롤)로 부드럽게 스크롤
  document.querySelector(".controls").scrollIntoView({ behavior: "smooth", block: "start" });
}

function setTabActive(groupId, value) {
  const group = document.getElementById(groupId);
  group.querySelectorAll(".tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.value === value);
  });
}

// ──────────────────────────────────────────
document.addEventListener("DOMContentLoaded", init);
