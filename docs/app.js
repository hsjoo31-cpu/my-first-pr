let HISTORY = [];

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

function renderEntry(data) {
  document.getElementById("target-month").textContent =
    formatMonthLabel(data.target_month);
  document.getElementById("period").textContent = data.period
    ? `${data.period.start} → ${data.period.end}`
    : "—";
  document.getElementById("updated-at").textContent = fmtDate(data.updated_at);
  document.getElementById("passed-count").textContent =
    fmtNum(data.passed_count || 0) + "개";

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

load();
