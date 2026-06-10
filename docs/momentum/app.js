let HISTORY = [];
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
      buildMonthSelector(history);
      renderMonth(history[0].target_month);
      buildDashboard(history);
      buildPerfAnalysis(history);
    } else {
      const res = await fetch("../data/results.json?ts=" + Date.now());
      if (!res.ok) throw new Error("HTTP " + res.status);
      const data = await res.json();
      const ym = data.target_month || (data.period && data.period.end ? data.period.end.slice(0, 7) : "current");
      HISTORY = [{ ...data, target_month: ym }];
      buildMonthSelector(HISTORY);
      renderEntry(HISTORY[0]);
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">데이터를 불러올 수 없습니다: ${e.message}</td></tr>`;
  }
}

function buildMonthSelector(history) {
  const sel = document.getElementById("month-select");
  sel.innerHTML = history.map(h =>
    `<option value="${h.target_month}">${formatMonthLabel(h.target_month)}</option>`
  ).join("");
  sel.addEventListener("change", e => renderMonth(e.target.value));
}

function formatMonthLabel(ym) {
  if (!ym || !ym.includes("-")) return ym || "—";
  const [y, m] = ym.split("-");
  return `${y}년 ${parseInt(m, 10)}월`;
}

function renderMonth(target_month) {
  const entry = HISTORY.find(h => h.target_month === target_month);
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

function renderEntry(data) {
  document.getElementById("target-month").textContent =
    formatMonthLabel(data.target_month);
  document.getElementById("period").textContent = data.period
    ? `${data.period.start} → ${data.period.end}`
    : "—";
  document.getElementById("updated-at").textContent = fmtDate(data.updated_at);
  document.getElementById("passed-count").textContent =
    fmtNum(data.passed_count || 0) + "개";

  // 다음 달 평균 수익률
  const fwdSection = document.getElementById("forward-section");
  const fr = data.forward_returns;
  if (fr && (fr.top5_avg_pct !== null || fr.top10_avg_pct !== null || fr.top20_avg_pct !== null)) {
    fwdSection.hidden = false;
    document.getElementById("fwd-month-label").textContent =
      `(${formatMonthLabel(fr.next_month)})`;
    document.getElementById("fwd-top5").innerHTML =
      formatReturn(fr.top5_avg_pct, fr.top5_n);
    document.getElementById("fwd-top10").innerHTML =
      formatReturn(fr.top10_avg_pct, fr.top10_n);
    document.getElementById("fwd-top20").innerHTML =
      formatReturn(fr.top20_avg_pct, fr.top20_n);
  } else {
    fwdSection.hidden = true;
  }

  const tbody = document.getElementById("results-body");
  const stocks = data.stocks || [];
  if (stocks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">해당 월에 통과한 종목이 없습니다.</td></tr>`;
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

load();
