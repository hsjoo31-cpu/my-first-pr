"use strict";

// ──────────────────────────────────────────
// 상태
// ──────────────────────────────────────────
let allEvents = [];   // fetcher가 만든 원본 이벤트 (다음날 OHLC 포함)

const params = {
  target: 5,       // 목표수익률 (%)
  market: "ALL",   // "ALL" | "KOSPI" | "KOSDAQ"
  minCap: 10000,   // 시총 하한 (억원) — 10000 = 1조
};

// 이벤트 테이블 정렬 상태
let sort = { key: "d0", dir: -1 }; // 기본: 상한가일 내림차순

// 목표수익률별 성과표에 표시할 목표 후보
const SWEEP_TARGETS = [1, 2, 3, 4, 5, 7, 10, 15, 20, 25, 30];

// ──────────────────────────────────────────
// 초기화
// ──────────────────────────────────────────
async function init() {
  bindControls();
  await loadData();
}

async function loadData() {
  try {
    const res = await fetch("../data/limitup_data.json?ts=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    allEvents = data.events || [];
    document.getElementById("updated-at").textContent = data.updated_at || "—";
    render();
  } catch (e) {
    setBody(`<tr><td colspan="10" class="empty">데이터를 불러올 수 없습니다: ${e.message}</td></tr>`);
  }
}

// ──────────────────────────────────────────
// 컨트롤
// ──────────────────────────────────────────
function bindControls() {
  const slider = document.getElementById("t-slider");
  const tVal = document.getElementById("t-val");
  slider.addEventListener("input", () => {
    params.target = +slider.value;
    tVal.textContent = slider.value;
    render();
  });

  bindTabs("market-tabs", (v) => { params.market = v; render(); });
  bindTabs("cap-tabs", (v) => { params.minCap = +v; render(); });

  // 이벤트 테이블 헤더 정렬
  document.querySelectorAll("#results-table th.sortable").forEach((th) => {
    th.addEventListener("click", () => {
      const key = th.dataset.key;
      if (sort.key === key) sort.dir *= -1;
      else sort = { key, dir: key === "d0" ? -1 : -1 };
      renderEventsTable(currentRows());
    });
  });
}

function bindTabs(groupId, onChange) {
  const group = document.getElementById(groupId);
  group.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      group.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(btn.dataset.value);
    });
  });
}

// ──────────────────────────────────────────
// 백테스트 핵심
// ──────────────────────────────────────────

// 필터(시장·시총) 통과한 이벤트만
function filtered() {
  return allEvents.filter(
    (e) =>
      (params.market === "ALL" || e.market === params.market) &&
      e.cap >= params.minCap
  );
}

/**
 * 단일 이벤트에 목표수익률 T를 적용해 거래 결과 계산.
 *  매수 = 다음 거래일 시초가(o1)
 *  목표가 = o1 * (1 + T/100)
 *  당일 고가(h1)가 목표가 도달 → +T% 익절
 *  미달 → 당일 종가(c1) 매도
 */
function evalEvent(e, target) {
  const buy = e.o1;
  const targetPrice = buy * (1 + target / 100);
  const hit = e.h1 >= targetPrice;
  const ret = hit ? target : (e.c1 / buy - 1) * 100;
  return {
    ...e,
    buy,
    hit,
    ret,
    gap: (e.o1 / e.c0 - 1) * 100,       // 상한가 종가 → 시초가 갭
    maxUp: (e.h1 / e.o1 - 1) * 100,     // 시초가 대비 당일 최고 상승
    closeRet: (e.c1 / e.o1 - 1) * 100,  // 시초가 대비 종가 (목표 없이 종가청산)
  };
}

// 한 세트(이벤트 배열)에 목표 T 적용한 집계 통계
function stats(events, target) {
  const rows = events.map((e) => evalEvent(e, target));
  const n = rows.length;
  if (n === 0) return { n: 0 };
  const wins = rows.filter((r) => r.hit).length;
  const sum = rows.reduce((a, r) => a + r.ret, 0);
  const posn = rows.filter((r) => r.ret > 0).length;
  const closeSum = rows.reduce((a, r) => a + r.closeRet, 0);
  const gapSum = rows.reduce((a, r) => a + r.gap, 0);
  return {
    n,
    wins,
    winRate: (wins / n) * 100,
    avg: sum / n,
    cum: sum,
    hitRate: (posn / n) * 100,   // 수익률>0 비율(승률)
    closeAvg: closeSum / n,      // 목표 없이 종가청산 시 평균
    gapAvg: gapSum / n,
  };
}

// ──────────────────────────────────────────
// 렌더링
// ──────────────────────────────────────────
function render() {
  const events = filtered();
  const s = stats(events, params.target);

  setCard("total-count", s.n ? s.n + "건" : "—");
  setCard("win-count", s.n ? s.wins + "건" : "—");
  setCard("win-rate", s.n ? s.winRate.toFixed(1) + "%" : "—");
  setPct("avg-return", s.n ? s.avg : null);
  setPct("cum-return", s.n ? s.cum : null);
  setCard("hit-rate", s.n ? s.hitRate.toFixed(1) + "%" : "—");
  setPct("close-avg", s.n ? s.closeAvg : null);
  setPct("gap-avg", s.n ? s.gapAvg : null);

  renderSweep(events);
  renderYearly(events);
  renderEventsTable(currentRows());
}

function currentRows() {
  return filtered().map((e) => evalEvent(e, params.target));
}

// 목표수익률별 성과표
function renderSweep(events) {
  const body = document.getElementById("sweep-body");
  if (!events.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">조건에 맞는 이벤트가 없습니다</td></tr>';
    return;
  }
  const base = stats(events, 1).closeAvg; // 종가매도 기준(목표 무관 동일)
  body.innerHTML = SWEEP_TARGETS.map((t) => {
    const s = stats(events, t);
    const sel = t === params.target ? " selected" : "";
    const diff = s.avg - base; // 종가매도 대비 평균수익률 개선폭
    return `<tr class="sweep-row${sel}" data-t="${t}">
      <td>+${t}%</td>
      <td class="num">${s.wins}건</td>
      <td class="num">${s.winRate.toFixed(1)}%</td>
      ${pctCell(s.avg)}
      ${pctCell(s.cum)}
      ${pctCell(diff)}
    </tr>`;
  }).join("");

  // 행 클릭 → 해당 목표로 슬라이더 이동
  body.querySelectorAll(".sweep-row").forEach((tr) => {
    tr.addEventListener("click", () => {
      const t = +tr.dataset.t;
      params.target = t;
      document.getElementById("t-slider").value = t;
      document.getElementById("t-val").textContent = t;
      render();
    });
  });
}

// 연도별 성과 (현재 목표수익률)
function renderYearly(events) {
  const body = document.getElementById("yearly-body");
  if (!events.length) {
    body.innerHTML = '<tr><td colspan="5" class="empty">조건에 맞는 이벤트가 없습니다</td></tr>';
    return;
  }
  const years = [...new Set(events.map((e) => e.d0.slice(0, 4)))].sort();
  body.innerHTML = years
    .map((y) => {
      const s = stats(events.filter((e) => e.d0.slice(0, 4) === y), params.target);
      return `<tr>
        <td><strong>${y}</strong></td>
        <td class="num">${s.n}건</td>
        <td class="num">${s.winRate.toFixed(1)}%</td>
        ${pctCell(s.avg)}
        ${pctCell(s.cum)}
      </tr>`;
    })
    .join("");
}

// 이벤트별 결과 테이블 (정렬 적용)
function renderEventsTable(rows) {
  updateSortHeaders();
  if (!rows.length) {
    setBody('<tr><td colspan="10" class="empty">조건에 맞는 이벤트가 없습니다</td></tr>');
    document.getElementById("results-note").textContent = "";
    return;
  }
  const dir = sort.dir;
  const sorted = [...rows].sort((a, b) => {
    const va = a[sort.key], vb = b[sort.key];
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
  document.getElementById("results-note").textContent = `${rows.length}건`;
  setBody(sorted.map(buildRow).join(""));
}

function buildRow(r) {
  const badge = r.gap_days > 4
    ? `<span class="badge badge-halt">⚠ 거래정지후</span>`
    : r.hit
      ? `<span class="badge badge-target">✅ 목표달성</span>`
      : r.ret >= 0
        ? `<span class="badge badge-close">종가매도</span>`
        : `<span class="badge badge-loss">종가손실</span>`;

  return `<tr>
    <td>${r.d0}</td>
    <td><strong>${esc(r.name)}</strong></td>
    <td><span class="market-tag">${esc(r.market)}</span></td>
    <td class="num">${fmtCap(r.cap)}</td>
    <td class="num positive">+${r.ret0.toFixed(1)}%</td>
    <td class="num ${cls(r.gap)}">${fmt(r.gap)}</td>
    <td class="num ${cls(r.maxUp)}">${fmt(r.maxUp)}</td>
    <td class="num ${cls(r.closeRet)}">${fmt(r.closeRet)}</td>
    <td class="num ${cls(r.ret)}">${fmt(r.ret)}</td>
    <td>${badge}</td>
  </tr>`;
}

function updateSortHeaders() {
  document.querySelectorAll("#results-table th.sortable").forEach((th) => {
    const active = th.dataset.key === sort.key;
    th.classList.toggle("sorted", active);
    const caret = active ? (sort.dir < 0 ? " ▼" : " ▲") : "";
    th.innerHTML = th.textContent.replace(/[ ▼▲]+$/, "") +
      `<span class="caret">${caret}</span>`;
  });
}

// ──────────────────────────────────────────
// 포맷 유틸
// ──────────────────────────────────────────
function fmt(n, digits = 1) {
  if (n == null || isNaN(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(digits) + "%";
}
function cls(n) {
  if (n == null || isNaN(n)) return "";
  return n >= 0 ? "positive" : "negative";
}
function pctCell(v) {
  return v != null && !isNaN(v)
    ? `<td class="num ${cls(v)}">${fmt(v)}</td>`
    : '<td class="num">—</td>';
}
// 시총(억원) → "1.3조" / "8,200억"
function fmtCap(eok) {
  if (eok >= 10000) return (eok / 10000).toFixed(1) + "조";
  return eok.toLocaleString("ko-KR") + "억";
}
function setCard(id, text) {
  document.getElementById(id).textContent = text;
}
function setPct(id, v) {
  const el = document.getElementById(id);
  el.textContent = v != null ? fmt(v) : "—";
  el.className = "value " + (v == null ? "" : v >= 0 ? "positive" : "negative");
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
