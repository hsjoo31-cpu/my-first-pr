let HISTORY = [];   // 원본(측정월 기준) — 대시보드/퍼포먼스 집계에 사용
let TP_CHART = null;
let CURRENT_TP = 50;
let HOLDING = [];   // 보유(투자)월 기준으로 재구성한 엔트리 — 상단 뷰에 사용
let YEAR_CHART = null;
let MONTH_CHART = null;

async function load() {
  const tbody = document.getElementById("results-body");
  try {
    let history = [];
    try {
      const hres = await fetch("../data/history.json?ts=" + Date.now());
      if (hres.ok) history = await hres.json();
    } catch (_) {}

    if (history.length > 0) {
      HISTORY = history;
      buildHolding(history);
      buildMonthSelector(HOLDING);
      renderEntry(HOLDING[0]);
      buildDashboard(history);
      buildPerfAnalysis(history);
      setupTPControls();
      buildTPComparison(history, CURRENT_TP);
    } else {
      const res = await fetch("../data/results.json?ts=" + Date.now());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const ym = data.target_month || (data.period && data.period.end ? data.period.end.slice(0, 7) : "current");
      HISTORY = [{ ...data, target_month: ym }];
      buildHolding(HISTORY);
      buildMonthSelector(HOLDING);
      renderEntry(HOLDING[0]);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">데이터를 불러올 수 없습니다: ${e.message}</td></tr>`;
  }
}

// ym("2026-04") + 1개월 → "2026-05"
function addMonthYM(ym) {
  let [y, m] = ym.split("-").map(Number);
  m += 1;
  if (m > 12) { m = 1; y += 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}

// 측정월 기준 history → 보유(투자)월 기준 엔트리로 변환.
// 측정월 M의 종목은 다음 달(M+1)에 보유하므로, 보유월 = M+1.
// 보유월의 수익률 = 측정월 M의 forward_returns.
function buildHolding(history) {
  HOLDING = history.map(e => {
    const fr = e.forward_returns;
    const holding_month = (fr && fr.next_month) ? fr.next_month : addMonthYM(e.target_month);
    return {
      holding_month,             // 실제 보유한 달
      measure_month: e.target_month, // 직전 월(선별 시점)
      period: e.period,          // 선별에 쓴 월봉 구간
      updated_at: e.updated_at,
      passed_count: e.passed_count,
      stocks: e.stocks || [],
      returns: fr || null,       // null = 아직 집계 전(해당 월 미종료)
    };
  });
  HOLDING.sort((a, b) => (a.holding_month < b.holding_month ? 1 : -1)); // 최신순
}

function buildMonthSelector(holding) {
  const sel = document.getElementById("month-select");
  sel.innerHTML = holding.map(h =>
    `<option value="${h.holding_month}">${formatMonthLabel(h.holding_month)}${h.returns ? "" : " · 집계 전"}</option>`
  ).join("");
  sel.addEventListener("change", e => renderHoldingMonth(e.target.value));
}

function formatMonthLabel(ym) {
  if (!ym || !ym.includes("-")) return ym || "—";
  const [y, m] = ym.split("-");
  return `${y}년 ${parseInt(m, 10)}월`;
}

function renderHoldingMonth(holding_month) {
  const entry = HOLDING.find(h => h.holding_month === holding_month);
  if (entry) renderEntry(entry);
}

function fmtDate(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return d.toLocaleString("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtNum(n) {
  return new Intl.NumberFormat("ko-KR").format(n);
}

function formatReturn(pct, n) {
  if (pct === null || pct === undefined) return "—";
  const cls = pct >= 0 ? "positive" : "negative";
  const sign = pct >= 0 ? "+" : "";
  return `<span class="${cls}">${sign}${pct.toFixed(2)}%</span>` +
         `<small class="value-sub">${n}개 평균</small>`;
}

function renderEntry(h) {
  // 상단은 '보유(투자)월' 기준
  document.getElementById("target-month").textContent =
    formatMonthLabel(h.holding_month);
  document.getElementById("period").textContent = h.period
    ? `${h.period.start} → ${h.period.end}`
    : "—";
  document.getElementById("updated-at").textContent = fmtDate(h.updated_at);
  document.getElementById("passed-count").textContent =
    fmtNum(h.passed_count || 0) + "개";

  // 해당 보유월의 수익률
  const fwdSection = document.getElementById("forward-section");
  const fr = h.returns;
  const label = document.getElementById("fwd-month-label");
  fwdSection.hidden = false;
  if (fr && (fr.top5_avg_pct !== null || fr.top10_avg_pct !== null || fr.top20_avg_pct !== null)) {
    label.textContent = `(${formatMonthLabel(h.holding_month)})`;
    document.getElementById("fwd-top5").innerHTML = formatReturn(fr.top5_avg_pct, fr.top5_n);
    document.getElementById("fwd-top10").innerHTML = formatReturn(fr.top10_avg_pct, fr.top10_n);
    document.getElementById("fwd-top20").innerHTML = formatReturn(fr.top20_avg_pct, fr.top20_n);
  } else {
    // 아직 해당 월이 끝나지 않아 수익률 집계 전
    label.textContent = `(${formatMonthLabel(h.holding_month)} · 집계 전)`;
    document.getElementById("fwd-top5").innerHTML = "<span class='value-sub'>집계 전</span>";
    document.getElementById("fwd-top10").innerHTML = "<span class='value-sub'>집계 전</span>";
    document.getElementById("fwd-top20").innerHTML = "<span class='value-sub'>집계 전</span>";
  }

  const tbody = document.getElementById("results-body");
  const stocks = h.stocks || [];
  if (stocks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">해당 월에 보유할 종목이 없습니다.</td></tr>`;
    return;
  }

  tbody.innerHTML = stocks.map(s => {
    const retClass = s.return_pct >= 0 ? "positive" : "negative";
    const retSign = s.return_pct >= 0 ? "+" : "";
    return `
      <tr>
        <td>${s.rank}</td>
        <td><strong>${s.name}</strong></td>
        <td>${s.ticker}</td>
        <td><span class="market-tag">${s.market || "-"}</span></td>
        <td class="num ${retClass}">${retSign}${s.return_pct.toFixed(2)}%</td>
        <td class="num">${fmtNum(s.marcap_eok)}</td>
        <td class="num">${s.report_count}</td>
        <td>
          <a href="https://finance.naver.com/item/main.naver?code=${s.ticker}"
             target="_blank" rel="noopener">네이버 ↗</a>
        </td>
      </tr>
    `;
  }).join("");
}

function buildDashboard(history) {
  const byYear = {};
  const byMonth = {};

  for (const entry of history) {
    const fr = entry.forward_returns;
    if (!fr || !fr.next_month) continue;
    const [year, month] = fr.next_month.split("-");

    if (!byYear[year]) byYear[year] = { top5: [], top10: [], top20: [] };
    if (!byMonth[month]) byMonth[month] = { top5: [], top10: [], top20: [] };

    for (const k of ["top5", "top10", "top20"]) {
      const v = fr[`${k}_avg_pct`];
      if (v !== null && v !== undefined) {
        byYear[year][k].push(v);
        byMonth[month][k].push(v);
      }
    }
  }

  const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;
  const sum = arr => arr.length ? arr.reduce((a, b) => a + b, 0) : null;

  const years = Object.keys(byYear).sort();
  const yearRows = years.map(y => {
    const d = byYear[y];
    return {
      label: `${y}년`,
      count: d.top10.length,
      top5_mean: mean(d.top5), top5_sum: sum(d.top5),
      top10_mean: mean(d.top10), top10_sum: sum(d.top10),
      top20_mean: mean(d.top20), top20_sum: sum(d.top20),
    };
  });

  // 전체 기간 합산/평균 추가
  const allTop5  = years.flatMap(y => byYear[y].top5);
  const allTop10 = years.flatMap(y => byYear[y].top10);
  const allTop20 = years.flatMap(y => byYear[y].top20);
  yearRows.push({
    label: "전체",
    count: allTop10.length,
    top5_mean: mean(allTop5),   top5_sum: sum(allTop5),
    top10_mean: mean(allTop10), top10_sum: sum(allTop10),
    top20_mean: mean(allTop20), top20_sum: sum(allTop20),
    isTotal: true,
  });

  const allMonths = ["01","02","03","04","05","06","07","08","09","10","11","12"];
  const monthRows = allMonths.map(m => {
    const d = byMonth[m] || { top5: [], top10: [], top20: [] };
    return {
      label: `${parseInt(m, 10)}월`,
      count: d.top10.length,
      top5_mean: mean(d.top5), top5_sum: sum(d.top5),
      top10_mean: mean(d.top10), top10_sum: sum(d.top10),
      top20_mean: mean(d.top20), top20_sum: sum(d.top20),
    };
  });

  renderStatsTable("year-table-body", yearRows);
  renderStatsTable("month-table-body", monthRows);

  // 차트: 연도별은 합산, 월별은 평균
  YEAR_CHART = renderBarChart(
    "year-chart", YEAR_CHART,
    yearRows.map(r => r.label),
    {
      top5: yearRows.map(r => r.top5_sum),
      top10: yearRows.map(r => r.top10_sum),
      top20: yearRows.map(r => r.top20_sum),
    },
  );
  MONTH_CHART = renderBarChart(
    "month-chart", MONTH_CHART,
    monthRows.map(r => r.label),
    {
      top5: monthRows.map(r => r.top5_mean),
      top10: monthRows.map(r => r.top10_mean),
      top20: monthRows.map(r => r.top20_mean),
    },
  );
}

function renderBarChart(canvasId, prev, labels, series) {
  if (typeof Chart === "undefined") return null;
  if (prev) prev.destroy();
  const ctx = document.getElementById(canvasId).getContext("2d");

  Chart.defaults.color = "#8a93a6";
  Chart.defaults.borderColor = "#2a3142";
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Pretendard', sans-serif";

  // datalabels 플러그인 등록 (1회)
  if (window.ChartDataLabels && !Chart._dlRegistered) {
    Chart.register(window.ChartDataLabels);
    Chart._dlRegistered = true;
  }

  const datasets = [
    { key: "top5",  label: "Top 5",  bg: "rgba(251,191,36,0.78)", bc: "#d97706" },
    { key: "top10", label: "Top 10", bg: "rgba(74,222,128,0.78)", bc: "#16a34a" },
    { key: "top20", label: "Top 20", bg: "rgba(96,165,250,0.78)", bc: "#3b82f6" },
  ].map(s => ({
    label: s.label,
    data: series[s.key],
    backgroundColor: s.bg,
    borderColor: s.bc,
    borderWidth: 1,
    borderRadius: 3,
  }));

  return new Chart(ctx, {
    type: "bar",
    data: { labels: labels, datasets: datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      plugins: {
        legend: {
          position: "top",
          labels: { boxWidth: 14, boxHeight: 14, padding: 12 },
        },
        tooltip: {
          backgroundColor: "#1a1f2e",
          borderColor: "#2a3142",
          borderWidth: 1,
          padding: 10,
          callbacks: {
            label: (c) => {
              const v = c.parsed.y;
              if (v === null) return `${c.dataset.label}: 데이터 없음`;
              const sign = v >= 0 ? "+" : "";
              return `${c.dataset.label}: ${sign}${v.toFixed(2)}%`;
            },
          },
        },
        datalabels: {
          anchor: (ctx) => ctx.dataset.data[ctx.dataIndex] >= 0 ? "end" : "start",
          align:  (ctx) => ctx.dataset.data[ctx.dataIndex] >= 0 ? "end" : "start",
          color: "#e8ecf3",
          font: { size: 10, weight: "600" },
          formatter: (v) => {
            if (v === null || v === undefined) return "";
            const sign = v >= 0 ? "+" : "";
            return `${sign}${v.toFixed(1)}%`;
          },
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          grid: { color: "rgba(42, 49, 66, 0.6)" },
          ticks: { callback: (v) => `${v >= 0 ? "+" : ""}${v}%` },
        },
      },
    },
  });
}

function renderStatsTable(tbodyId, rows) {
  const tbody = document.getElementById(tbodyId);
  if (rows.length === 0 || rows.every(r => r.count === 0)) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">데이터 없음</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr${r.isTotal ? ' class="total-row"' : ""}>
      <td><strong>${r.label}</strong></td>
      <td class="num">${r.count}</td>
      <td class="num ${retClass(r.top5_mean)}">${fmtPct(r.top5_mean)}</td>
      <td class="num ${retClass(r.top5_sum)}">${fmtPct(r.top5_sum)}</td>
      <td class="num ${retClass(r.top10_mean)}">${fmtPct(r.top10_mean)}</td>
      <td class="num ${retClass(r.top10_sum)}">${fmtPct(r.top10_sum)}</td>
      <td class="num ${retClass(r.top20_mean)}">${fmtPct(r.top20_mean)}</td>
      <td class="num ${retClass(r.top20_sum)}">${fmtPct(r.top20_sum)}</td>
    </tr>
  `).join("");
}

function fmtPct(v) {
  if (v === null || v === undefined) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function retClass(v) {
  if (v === null || v === undefined) return "";
  return v >= 0 ? "positive" : "negative";
}

// ──────────────────────────────────────────
// 퍼포먼스 분석 (기간·투자월 선택)
// ──────────────────────────────────────────
let PERF_DATA = [];
let PERF_CHART = null;
const PERF_STATE = {
  start: null, end: null, basis: "top10",
  months: new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
};

function shortYm(ym) {
  const [y, m] = ym.split("-");
  return `${y.slice(2)}.${m}`;
}

function pctSpan(v) {
  if (v === null || v === undefined) return "—";
  const cls = v >= 0 ? "positive" : "negative";
  const sign = v >= 0 ? "+" : "";
  return `<span class="${cls}">${sign}${v.toFixed(2)}%</span>`;
}

function buildPerfAnalysis(history) {
  // 투자 단위 = forward_returns.next_month (그 달에 매수해 보유)
  PERF_DATA = [];
  for (const e of history) {
    const fr = e.forward_returns;
    if (!fr || !fr.next_month) continue;
    const [y, m] = fr.next_month.split("-");
    PERF_DATA.push({
      ym: fr.next_month, year: +y, month: +m,
      top5: fr.top5_avg_pct, top10: fr.top10_avg_pct, top20: fr.top20_avg_pct,
    });
  }
  PERF_DATA.sort((a, b) => (a.ym < b.ym ? -1 : a.ym > b.ym ? 1 : 0));
  if (!PERF_DATA.length) return;

  // 기간 select
  const startSel = document.getElementById("perf-start");
  const endSel = document.getElementById("perf-end");
  const opts = PERF_DATA
    .map(d => `<option value="${d.ym}">${formatMonthLabel(d.ym)}</option>`)
    .join("");
  startSel.innerHTML = opts;
  endSel.innerHTML = opts;
  PERF_STATE.start = PERF_DATA[0].ym;
  PERF_STATE.end = PERF_DATA[PERF_DATA.length - 1].ym;
  startSel.value = PERF_STATE.start;
  endSel.value = PERF_STATE.end;
  startSel.addEventListener("change", () => { PERF_STATE.start = startSel.value; updatePerf(); });
  endSel.addEventListener("change", () => { PERF_STATE.end = endSel.value; updatePerf(); });

  // 투자 월 토글
  const monthsWrap = document.getElementById("perf-months");
  monthsWrap.innerHTML = Array.from({ length: 12 }, (_, i) => i + 1)
    .map(m => `<button type="button" class="perf-month-btn active" data-month="${m}">${m}월</button>`)
    .join("");
  monthsWrap.querySelectorAll(".perf-month-btn").forEach(btn => {
    btn.addEventListener("click", () => {
      const m = +btn.dataset.month;
      if (PERF_STATE.months.has(m)) { PERF_STATE.months.delete(m); btn.classList.remove("active"); }
      else { PERF_STATE.months.add(m); btn.classList.add("active"); }
      updatePerf();
    });
  });
  document.getElementById("perf-months-all").addEventListener("click", () => {
    PERF_STATE.months = new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    monthsWrap.querySelectorAll(".perf-month-btn").forEach(b => b.classList.add("active"));
    updatePerf();
  });
  document.getElementById("perf-months-none").addEventListener("click", () => {
    PERF_STATE.months = new Set();
    monthsWrap.querySelectorAll(".perf-month-btn").forEach(b => b.classList.remove("active"));
    updatePerf();
  });

  // 기준 탭
  const basisWrap = document.getElementById("perf-basis");
  basisWrap.querySelectorAll(".tab").forEach(btn => {
    btn.addEventListener("click", () => {
      basisWrap.querySelectorAll(".tab").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      PERF_STATE.basis = btn.dataset.value;
      updatePerf();
    });
  });

  updatePerf();
}

function updatePerf() {
  const { start, end, basis, months } = PERF_STATE;
  const lo = start <= end ? start : end;
  const hi = start <= end ? end : start;

  const pts = PERF_DATA.filter(
    d => d.ym >= lo && d.ym <= hi && months.has(d.month) && d[basis] != null
  );
  const rets = pts.map(d => d[basis]);
  const count = rets.length;
  const sum = rets.reduce((a, b) => a + b, 0);
  const avg = count ? sum / count : null;

  document.getElementById("perf-count").textContent = count + "개월";
  document.getElementById("perf-sum").innerHTML = count ? pctSpan(sum) : "—";
  document.getElementById("perf-avg").innerHTML = count ? pctSpan(avg) : "—";

  const exEl = document.getElementById("perf-extremes");
  if (count) {
    let best = pts[0], worst = pts[0];
    for (const d of pts) {
      if (d[basis] > best[basis]) best = d;
      if (d[basis] < worst[basis]) worst = d;
    }
    exEl.innerHTML =
      `▲ ${shortYm(best.ym)} ${pctSpan(best[basis])}<br>▼ ${shortYm(worst.ym)} ${pctSpan(worst[basis])}`;
  } else {
    exEl.textContent = "—";
  }

  // 월별 합산 (선택한 캘린더 월별)
  const byM = {};
  for (const d of pts) (byM[d.month] = byM[d.month] || []).push(d[basis]);
  const selMonths = [...months].sort((a, b) => a - b);
  const tbody = document.getElementById("perf-month-body");
  if (!selMonths.length) {
    tbody.innerHTML = `<tr><td colspan="4" class="empty">투자 월을 선택하세요</td></tr>`;
  } else {
    tbody.innerHTML = selMonths.map(m => {
      const arr = byM[m] || [];
      const s = arr.length ? arr.reduce((a, b) => a + b, 0) : null;
      const a = arr.length ? s / arr.length : null;
      return `<tr>
        <td><strong>${m}월</strong></td>
        <td class="num">${arr.length}</td>
        <td class="num ${retClass(s)}">${fmtPct(s)}</td>
        <td class="num ${retClass(a)}">${fmtPct(a)}</td>
      </tr>`;
    }).join("");
  }

  // 차트: 투자한 달의 수익률(시간순)
  PERF_CHART = renderPerfChart(
    "perf-chart", PERF_CHART,
    pts.map(d => shortYm(d.ym)), pts.map(d => d[basis]), basis
  );
}

function renderPerfChart(canvasId, prev, labels, data, basis) {
  if (typeof Chart === "undefined") return null;
  if (prev) prev.destroy();
  const ctx = document.getElementById(canvasId).getContext("2d");
  if (window.ChartDataLabels && !Chart._dlRegistered) {
    Chart.register(window.ChartDataLabels);
    Chart._dlRegistered = true;
  }
  if (!labels.length) return null; // 그릴 데이터 없음 → 빈 캔버스

  const bg = data.map(v => v >= 0 ? "rgba(74,222,128,0.78)" : "rgba(248,113,113,0.78)");
  const bc = data.map(v => v >= 0 ? "#16a34a" : "#dc2626");
  const labelMap = { top5: "Top 5", top10: "Top 10", top20: "Top 20" };

  return new Chart(ctx, {
    type: "bar",
    data: {
      labels,
      datasets: [{
        label: `${labelMap[basis]} 월 수익률`,
        data, backgroundColor: bg, borderColor: bc, borderWidth: 1, borderRadius: 3,
      }],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: "#1a1f2e", borderColor: "#2a3142", borderWidth: 1, padding: 10,
          callbacks: { label: (c) => { const v = c.parsed.y; return `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`; } },
        },
        datalabels: {
          anchor: (c) => c.dataset.data[c.dataIndex] >= 0 ? "end" : "start",
          align: (c) => c.dataset.data[c.dataIndex] >= 0 ? "end" : "start",
          color: "#e8ecf3", font: { size: 9, weight: "600" },
          formatter: (v) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`,
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: "rgba(42, 49, 66, 0.6)" }, ticks: { callback: (v) => `${v >= 0 ? "+" : ""}${v}%` } },
      },
    },
  });
}

function setupTPControls() {
  const controls = document.getElementById("tp-controls");
  if (!controls) return;
  controls.addEventListener("click", (e) => {
    const btn = e.target.closest(".tp-btn");
    if (!btn) return;
    const tp = parseInt(btn.dataset.tp, 10);
    if (!tp || tp === CURRENT_TP) return;
    CURRENT_TP = tp;
    controls.querySelectorAll(".tp-btn").forEach(b =>
      b.classList.toggle("active", parseInt(b.dataset.tp, 10) === tp)
    );
    buildTPComparison(HISTORY, CURRENT_TP);
  });
}

function buildTPComparison(history, tp) {
  const section = document.getElementById("tp-section");
  const tpKey = String(tp);

  // 데이터 유무 검사
  const hasTP = history.some(e =>
    e.forward_returns && e.forward_returns.take_profit &&
    e.forward_returns.take_profit[tpKey]
  );
  if (!hasTP) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  // 연도별 집계
  const byYear = {};
  for (const entry of history) {
    const fr = entry.forward_returns;
    if (!fr || !fr.next_month) continue;
    const [year] = fr.next_month.split("-");
    if (!byYear[year]) byYear[year] = {
      bh5: [], bh10: [], bh20: [],
      tp5: [], tp10: [], tp20: [],
    };
    for (const k of [5, 10, 20]) {
      const v = fr[`top${k}_avg_pct`];
      if (v != null) byYear[year][`bh${k}`].push(v);
    }
    const tpData = fr.take_profit && fr.take_profit[tpKey];
    if (tpData) {
      for (const k of [5, 10, 20]) {
        const v = tpData[`top${k}_avg_pct`];
        if (v != null) byYear[year][`tp${k}`].push(v);
      }
    }
  }

  const sum = arr => arr.length ? arr.reduce((a, b) => a + b, 0) : null;

  const years = Object.keys(byYear).sort();
  const rows = years.map(y => {
    const d = byYear[y];
    return {
      label: `${y}년`,
      count: d.bh10.length,
      bh5: sum(d.bh5), tp5: sum(d.tp5),
      bh10: sum(d.bh10), tp10: sum(d.tp10),
      bh20: sum(d.bh20), tp20: sum(d.tp20),
    };
  });

  const allBH5  = years.flatMap(y => byYear[y].bh5);
  const allTP5  = years.flatMap(y => byYear[y].tp5);
  const allBH10 = years.flatMap(y => byYear[y].bh10);
  const allTP10 = years.flatMap(y => byYear[y].tp10);
  const allBH20 = years.flatMap(y => byYear[y].bh20);
  const allTP20 = years.flatMap(y => byYear[y].tp20);
  rows.push({
    label: "전체",
    count: allBH10.length,
    bh5: sum(allBH5),   tp5: sum(allTP5),
    bh10: sum(allBH10), tp10: sum(allTP10),
    bh20: sum(allBH20), tp20: sum(allTP20),
    isTotal: true,
  });

  renderTPTable(rows);
  TP_CHART = renderTPChart("tp-chart", TP_CHART, rows, tp);
}

function renderTPTable(rows) {
  const tbody = document.getElementById("tp-table-body");
  tbody.innerHTML = rows.map(r => `
    <tr${r.isTotal ? ' class="total-row"' : ""}>
      <td><strong>${r.label}</strong></td>
      <td class="num">${r.count}</td>
      <td class="num ${retClass(r.bh5)}">${fmtPct(r.bh5)}</td>
      <td class="num ${retClass(r.tp5)}">${fmtPct(r.tp5)}</td>
      <td class="num ${retClass(r.bh10)}">${fmtPct(r.bh10)}</td>
      <td class="num ${retClass(r.tp10)}">${fmtPct(r.tp10)}</td>
      <td class="num ${retClass(r.bh20)}">${fmtPct(r.bh20)}</td>
      <td class="num ${retClass(r.tp20)}">${fmtPct(r.tp20)}</td>
    </tr>
  `).join("");
}

function renderTPChart(canvasId, prev, rows, tp) {
  if (typeof Chart === "undefined") return null;
  if (prev) prev.destroy();
  const ctx = document.getElementById(canvasId).getContext("2d");
  if (window.ChartDataLabels && !Chart._dlRegistered) {
    Chart.register(window.ChartDataLabels);
    Chart._dlRegistered = true;
  }

  return new Chart(ctx, {
    type: "bar",
    data: {
      labels: rows.map(r => r.label),
      datasets: [
        {
          label: "Top 10 보유",
          data: rows.map(r => r.bh10),
          backgroundColor: "rgba(74,222,128,0.78)",
          borderColor: "#16a34a", borderWidth: 1, borderRadius: 3,
        },
        {
          label: `Top 10 익절 +${tp}%`,
          data: rows.map(r => r.tp10),
          backgroundColor: "rgba(251,191,36,0.78)",
          borderColor: "#d97706", borderWidth: 1, borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      layout: { padding: { top: 18 } },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 14, boxHeight: 14, padding: 12 } },
        tooltip: {
          backgroundColor: "#1a1f2e",
          borderColor: "#2a3142", borderWidth: 1, padding: 10,
          callbacks: {
            label: (c) => {
              const v = c.parsed.y;
              if (v == null) return `${c.dataset.label}: 데이터 없음`;
              return `${c.dataset.label}: ${v >= 0 ? "+" : ""}${v.toFixed(1)}%`;
            },
          },
        },
        datalabels: {
          anchor: (ctx) => ctx.dataset.data[ctx.dataIndex] >= 0 ? "end" : "start",
          align:  (ctx) => ctx.dataset.data[ctx.dataIndex] >= 0 ? "end" : "start",
          color: "#e8ecf3",
          font: { size: 10, weight: "600" },
          formatter: (v) => v == null ? "" : `${v >= 0 ? "+" : ""}${v.toFixed(0)}%`,
        },
      },
      scales: {
        x: { grid: { display: false } },
        y: { grid: { color: "rgba(42,49,66,0.6)" }, ticks: { callback: (v) => `${v >= 0 ? "+" : ""}${v}%` } },
      },
    },
  });
}

load();
