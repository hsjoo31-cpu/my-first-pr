let HISTORY = [];
let YEAR_CHART = null;
let MONTH_CHART = null;

async function load() {
  const tbody = document.getElementById("results-body");
  try {
    let history = [];
    try {
      const hres = await fetch("data/history.json?ts=" + Date.now());
      if (hres.ok) history = await hres.json();
    } catch (_) {}

    if (history.length > 0) {
      HISTORY = history;
      buildMonthSelector(history);
      renderMonth(history[0].target_month);
      buildDashboard(history);
    } else {
      const res = await fetch("data/results.json?ts=" + Date.now());
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
  if (fr && (fr.top10_avg_pct !== null || fr.top20_avg_pct !== null)) {
    fwdSection.hidden = false;
    document.getElementById("fwd-month-label").textContent =
      `(${formatMonthLabel(fr.next_month)})`;
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

    if (!byYear[year]) byYear[year] = { top10: [], top20: [] };
    if (!byMonth[month]) byMonth[month] = { top10: [], top20: [] };

    if (fr.top10_avg_pct !== null && fr.top10_avg_pct !== undefined) {
      byYear[year].top10.push(fr.top10_avg_pct);
      byMonth[month].top10.push(fr.top10_avg_pct);
    }
    if (fr.top20_avg_pct !== null && fr.top20_avg_pct !== undefined) {
      byYear[year].top20.push(fr.top20_avg_pct);
      byMonth[month].top20.push(fr.top20_avg_pct);
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
      top10_mean: mean(d.top10),
      top10_sum: sum(d.top10),
      top20_mean: mean(d.top20),
      top20_sum: sum(d.top20),
    };
  });

  const allMonths = ["01","02","03","04","05","06","07","08","09","10","11","12"];
  const monthRows = allMonths.map(m => {
    const d = byMonth[m] || { top10: [], top20: [] };
    return {
      label: `${parseInt(m, 10)}월`,
      count: d.top10.length,
      top10_mean: mean(d.top10),
      top10_sum: sum(d.top10),
      top20_mean: mean(d.top20),
      top20_sum: sum(d.top20),
    };
  });

  renderStatsTable("year-table-body", yearRows);
  renderStatsTable("month-table-body", monthRows);

  // 차트: 연도별은 합산, 월별은 평균
  YEAR_CHART = renderBarChart(
    "year-chart", YEAR_CHART,
    yearRows.map(r => r.label),
    yearRows.map(r => r.top10_sum),
    yearRows.map(r => r.top20_sum),
  );
  MONTH_CHART = renderBarChart(
    "month-chart", MONTH_CHART,
    monthRows.map(r => r.label),
    monthRows.map(r => r.top10_mean),
    monthRows.map(r => r.top20_mean),
  );
}

function renderBarChart(canvasId, prev, labels, top10, top20) {
  if (typeof Chart === "undefined") return null;
  if (prev) prev.destroy();
  const ctx = document.getElementById(canvasId).getContext("2d");

  Chart.defaults.color = "#8a93a6";
  Chart.defaults.borderColor = "#2a3142";
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Pretendard', sans-serif";

  return new Chart(ctx, {
    type: "bar",
    data: {
      labels: labels,
      datasets: [
        {
          label: "Top 10",
          data: top10,
          backgroundColor: "rgba(74, 222, 128, 0.75)",
          borderColor: "#22c55e",
          borderWidth: 1,
          borderRadius: 3,
        },
        {
          label: "Top 20",
          data: top20,
          backgroundColor: "rgba(96, 165, 250, 0.75)",
          borderColor: "#3b82f6",
          borderWidth: 1,
          borderRadius: 3,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
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
      },
      scales: {
        x: { grid: { display: false } },
        y: {
          grid: { color: "rgba(42, 49, 66, 0.6)" },
          ticks: {
            callback: (v) => `${v >= 0 ? "+" : ""}${v}%`,
          },
        },
      },
    },
  });
}

function renderStatsTable(tbodyId, rows) {
  const tbody = document.getElementById(tbodyId);
  if (rows.length === 0 || rows.every(r => r.count === 0)) {
    tbody.innerHTML = `<tr><td colspan="6" class="empty">데이터 없음</td></tr>`;
    return;
  }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><strong>${r.label}</strong></td>
      <td class="num">${r.count}</td>
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

load();
