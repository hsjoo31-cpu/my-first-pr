"use strict";

// ──────────────────────────────────────────
// 상태
// ──────────────────────────────────────────
let allStocks = [];

const LC_STEP = 5; // 손절 기준 단위(입력란)

// 타게팅 기간 앵커 — 확약해제일 기준 (상장일 포함 5지점, 시간순)
const ANCHORS = [
  { key: "listing", label: "상장일",        date: (s) => s.ipo_date },
  { key: "d15",     label: "15일 확약해제",  date: (s) => addDays(s.ipo_date, 15) },
  { key: "m1",      label: "1개월 확약해제", date: (s) => addMonths(s.ipo_date, 1) },
  { key: "m3",      label: "3개월 확약해제", date: (s) => addMonths(s.ipo_date, 3) },
  { key: "m6",      label: "6개월 확약해제", date: (s) => addMonths(s.ipo_date, 6) },
];
const ANCHOR_ORDER = Object.fromEntries(ANCHORS.map((a, i) => [a.key, i]));
const anchorLabel = (k) => ANCHORS.find((a) => a.key === k).label;
const anchorDate = (k, s) => ANCHORS.find((a) => a.key === k).date(s);

const params = {
  reference: "listing_open", // "listing_open" | "ipo_price"
  n: 20,                     // 매수 하락률 (%)
  losscut: 10,               // 손절 기준 (%, 0 = 없음)
  target: 20,                // 목표수익률 (%)
  // 타게팅 기간: 시작 앵커일부터 매수 탐색, 종료 앵커일 전일 종가까지 보유
  targeting: { start: "listing", end: "m3" },
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
    renderLatestIpo();
    render();
  } catch (e) {
    setBody(`<tr><td colspan="11" class="empty">데이터를 불러올 수 없습니다: ${e.message}</td></tr>`);
  }
}

// 데이터 기준 가장 최근 상장일의 종목들을 헤더에 표시
// (매일 자동 갱신 시 새 종목이 추가되면 자동으로 바뀜)
function renderLatestIpo() {
  const wrap = document.getElementById("latest-ipo");
  const names = document.getElementById("latest-ipo-names");
  if (!wrap || !names || !allStocks.length) return;
  const latestDate = allStocks.reduce(
    (max, s) => (s.ipo_date > max ? s.ipo_date : max),
    allStocks[0].ipo_date
  );
  const latest = allStocks.filter((s) => s.ipo_date === latestDate);
  names.innerHTML =
    latest
      .map((s) => `<strong>${esc(s.name)}</strong> (${esc(s.market)})`)
      .join(", ") + ` · ${latestDate} 상장`;
  wrap.hidden = false;
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

  // 목표수익률 탭
  bindTabs("target-tabs", (val) => {
    params.target = +val;
    render();
  });

  // 타게팅 기간 앵커 선택 (2개 선택 = 시작~종료)
  bindTargeting();
}

// 타게팅 기간: 5개 앵커 중 2개를 클릭해 시작~종료 구간 지정.
// 2개 선택되면 시간순 정렬해 params.targeting에 반영하고 렌더.
// 1개만 선택된 중간 상태에서는 이전 구간 결과 유지.
let anchorSel = ["listing", "m3"];
function bindTargeting() {
  const group = document.getElementById("anchor-tabs");
  group.querySelectorAll(".anchor").forEach((btn) => {
    btn.addEventListener("click", () => {
      const key = btn.dataset.key;
      const i = anchorSel.indexOf(key);
      if (i >= 0) {
        anchorSel.splice(i, 1);            // 이미 선택 → 해제
      } else if (anchorSel.length < 2) {
        anchorSel.push(key);               // 추가
      } else {
        anchorSel = [key];                 // 2개 꽉 참 → 새로 시작
      }
      applyTargeting();
    });
  });
  applyTargeting();
}

function applyTargeting() {
  const group = document.getElementById("anchor-tabs");
  const rangeEl = document.getElementById("targeting-range");
  const ready = anchorSel.length === 2;
  let startK, endK;
  if (ready) {
    const sorted = [...anchorSel].sort((a, b) => ANCHOR_ORDER[a] - ANCHOR_ORDER[b]);
    [startK, endK] = sorted;
    params.targeting = { start: startK, end: endK };
  }
  group.querySelectorAll(".anchor").forEach((btn) => {
    const k = btn.dataset.key;
    const sel = anchorSel.includes(k);
    const inRange =
      ready && ANCHOR_ORDER[k] > ANCHOR_ORDER[startK] && ANCHOR_ORDER[k] < ANCHOR_ORDER[endK];
    btn.classList.toggle("active", sel);
    btn.classList.toggle("in-range", inRange);
  });
  if (ready) {
    rangeEl.textContent = `${anchorLabel(startK)} ~ ${anchorLabel(endK)}`;
    rangeEl.classList.remove("pending");
    render();
  } else {
    rangeEl.textContent =
      anchorSel.length === 1
        ? `${anchorLabel(anchorSel[0])} 선택됨 · 종료 지점을 하나 더 선택하세요`
        : "시작·종료 두 지점을 선택하세요";
    rangeEl.classList.add("pending");
  }
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

function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
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
 * 단일 종목 백테스트 (타게팅 기간 방식)
 *  - 기준가(상장일 시초가/공모가) 대비 n% 하락가에 매수
 *  - 매수 탐색 구간: [시작 앵커일, 종료 앵커일)  ← 이 구간 밖의 매수타점은 제외
 *  - 보유 한계: 종료 앵커일 '전일 종가'까지 (목표 미달 시 그 종가에 매도)
 * @returns status: "no_signal" | "ongoing" | "target" | "losscut" | "expired" | "ambiguous"
 */
function backtestStock(stock, p = params) {
  // 공모가 기준: 일봉이 수정주가이므로 무상증자·분할 배율로 조정한 공모가(ipo_price_adj)를 사용.
  // (없으면 명목 공모가. 시초가 기준은 시초가·일봉 모두 수정주가라 그대로 사용)
  const refPrice =
    p.reference === "ipo_price"
      ? (stock.ipo_price_adj ?? stock.ipo_price)
      : stock.listing_open;

  if (!refPrice) return { status: "no_signal", reason: "기준가 없음" };

  const buyTrigger = refPrice * (1 - p.n / 100);
  const prices = stock.prices; // [{d,o,h,l,c}, ...]

  const startDate = anchorDate(p.targeting.start, stock); // 매수 탐색 시작(포함)
  const endDate = anchorDate(p.targeting.end, stock);     // 확약해제일(미포함, 전일까지 보유)

  // 종료 앵커일 '전일'까지의 마지막 거래일 인덱스 (보유 한계)
  let forcedSellIdx = -1;
  for (let i = 0; i < prices.length; i++) {
    if (prices[i].d < endDate) forcedSellIdx = i;
    else break;
  }
  if (forcedSellIdx === -1) return { status: "no_signal" }; // 구간 이전 데이터뿐

  // 종료 앵커일이 실제 도래했는지(데이터에 그 이후 거래일 존재) — 미도래면 진행중 처리
  const endReached = prices[prices.length - 1].d >= endDate;

  // ── 매수일 탐색: [startDate, endDate) 안에서 첫 트리거 ──
  let buyIdx = -1;
  for (let i = 0; i <= forcedSellIdx; i++) {
    if (prices[i].d < startDate) continue;
    if (prices[i].l <= buyTrigger) {
      buyIdx = i;
      break;
    }
  }
  if (buyIdx === -1) return { status: "no_signal" };

  const buyPrice = buyTrigger;
  const buyDate = prices[buyIdx].d;
  const targetSellPrice =
    p.target > 0 ? buyPrice * (1 + p.target / 100) : Infinity;
  const losscutThreshold =
    p.losscut > 0 ? buyPrice * (1 - p.losscut / 100) : -Infinity;

  // ── 매수일부터 보유 한계(forcedSellIdx)까지 시뮬레이션 ──
  for (let i = buyIdx; i <= forcedSellIdx; i++) {
    const day = prices[i];
    const targetHit = day.h >= targetSellPrice;
    const losscutHit = p.losscut > 0 && day.c <= losscutThreshold;

    if (targetHit && losscutHit) {
      return { status: "ambiguous", buyDate, sellDate: day.d,
        daysHeld: daysBetween(buyDate, day.d), returnPct: null,
        refPrice, buyPrice, sellPrice: null };
    }
    if (targetHit) {
      return { status: "target", buyDate, sellDate: day.d,
        daysHeld: daysBetween(buyDate, day.d), returnPct: p.target,
        refPrice, buyPrice, sellPrice: Math.round(targetSellPrice) };
    }
    if (losscutHit) {
      return { status: "losscut", buyDate, sellDate: day.d,
        daysHeld: daysBetween(buyDate, day.d),
        returnPct: ((day.c - buyPrice) / buyPrice) * 100,
        refPrice, buyPrice, sellPrice: day.c };
    }
  }

  // 목표·손절 없이 보유 한계 도달
  if (endReached) {
    // 종료 확약해제일 전일 종가에 매도
    const day = prices[forcedSellIdx];
    return { status: "expired", buyDate, sellDate: day.d,
      daysHeld: daysBetween(buyDate, day.d),
      returnPct: ((day.c - buyPrice) / buyPrice) * 100,
      refPrice, buyPrice, sellPrice: day.c };
  }
  // 종료 확약해제일 미도래 → 아직 보유 중
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

  // 누적수익률 (완료 거래 수익률 단순 합)
  const cumReturn =
    returns.length > 0 ? returns.reduce((a, b) => a + b, 0) : null;
  const cumEl = document.getElementById("cum-return");
  cumEl.textContent = cumReturn != null ? fmt(cumReturn) : "—";
  cumEl.className = "value " + (cumReturn >= 0 ? "positive" : "negative");

  // 동시보유 최대 종목수 + 연도별 성과
  // (보유구간: 매수일 ~ 매도일, 진행중이면 데이터 마지막 날)
  const trades = signaled.map(({ stock, result }) => ({
    buyDate: result.buyDate,
    endDate: result.sellDate || stock.prices[stock.prices.length - 1].d,
    returnPct: result.returnPct != null ? result.returnPct : null,
  }));
  document.getElementById("peak-holdings").textContent = trades.length
    ? peakConcurrent(trades.map((t) => [t.buyDate, t.endDate])) + "종목"
    : "—";
  renderYearlyTable(trades);

  const note = document.getElementById("results-note");
  note.textContent =
    signaled.length > 0
      ? `신호 ${signaled.length}건 중 완료 ${completed.length}건 · 진행중 ${
          signaled.length - completed.length - results.filter(r=>r.result.status==='ambiguous').length
        }건`
      : "";

  // 테이블 렌더링 (매수 신호가 발생한 종목만, 매수일순 정렬)
  const sorted = [...signaled].sort((a, b) => {
    const da = a.result.buyDate || a.stock.ipo_date;
    const db = b.result.buyDate || b.stock.ipo_date;
    return da < db ? -1 : da > db ? 1 : 0;
  });

  const rows = sorted.map(({ stock, result }) => buildRow(stock, result)).join("");
  setBody(rows || '<tr><td colspan="11" class="empty">해당 조건에 매수 신호가 발생한 종목이 없습니다</td></tr>');
}

function nextDay(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

// 구간 [매수일, 종료일](양끝 포함)들의 최대 동시 겹침 수 — 이벤트 스위프
function peakConcurrent(intervals) {
  const events = [];
  for (const [b, e] of intervals) {
    events.push([b, 1], [nextDay(e), -1]);
  }
  // 같은 날짜면 -1(청산)을 +1(매수)보다 먼저 적용
  events.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  let cur = 0, peak = 0;
  for (const ev of events) {
    cur += ev[1];
    if (cur > peak) peak = cur;
  }
  return peak;
}

// 연도별(매수일 기준) 매수 종목수 · 동시보유 최대 · 누적/평균 수익률
function renderYearlyTable(trades) {
  const body = document.getElementById("yearly-body");
  if (!trades.length) {
    body.innerHTML =
      '<tr><td colspan="5" class="empty">해당 조건에 매수 신호가 발생한 종목이 없습니다</td></tr>';
    return;
  }
  const years = [...new Set(trades.map((t) => t.buyDate.slice(0, 4)))].sort();
  const pctCell = (v) =>
    v != null
      ? `<td class="num ${v >= 0 ? "positive" : "negative"}">${fmt(v)}</td>`
      : '<td class="num">—</td>';

  body.innerHTML = years
    .map((y) => {
      const bought = trades.filter((t) => t.buyDate.slice(0, 4) === y);
      const rets = bought.map((t) => t.returnPct).filter((v) => v != null);
      const cum = rets.length ? rets.reduce((a, b) => a + b, 0) : null;
      const avg = rets.length ? cum / rets.length : null;
      // 해당 연도 중 실제로 보유 중이던 모든 포지션(이월 포함)의 최대 겹침
      const yStart = y + "-01-01", yEnd = y + "-12-31";
      const clipped = trades
        .filter((t) => t.buyDate <= yEnd && t.endDate >= yStart)
        .map((t) => [
          t.buyDate > yStart ? t.buyDate : yStart,
          t.endDate < yEnd ? t.endDate : yEnd,
        ]);
      return `<tr>
        <td><strong>${y}</strong></td>
        <td class="num">${bought.length}종목</td>
        <td class="num">${peakConcurrent(clipped)}종목</td>
        ${pctCell(cum)}
        ${pctCell(avg)}
      </tr>`;
    })
    .join("");
}

function buildRow(stock, r) {
  const refLabel =
    params.reference === "ipo_price" ? "공모가" : "시초가";

  const statusBadge = {
    target:    `<span class="badge badge-target">✅ 목표달성</span>`,
    losscut:   `<span class="badge badge-losscut">❌ 손절</span>`,
    expired:   `<span class="badge badge-expired">⏱ 해제전 매도</span>`,
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
document.addEventListener("DOMContentLoaded", init);
