async function load() {
  const tbody = document.getElementById("results-body");
  try {
    const res = await fetch("data/results.json?ts=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();
    render(data);
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">데이터를 불러올 수 없습니다: ${e.message}</td></tr>`;
  }
}

function fmtDate(iso) {
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

function render(data) {
  document.getElementById("updated-at").textContent = fmtDate(data.updated_at);
  document.getElementById("period").textContent =
    `${data.period.start} → ${data.period.end}`;
  document.getElementById("universe-size").textContent =
    fmtNum(data.universe_size) + "개";
  document.getElementById("passed-count").textContent =
    fmtNum(data.passed_count) + "개";

  const tbody = document.getElementById("results-body");
  if (!data.stocks || data.stocks.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" class="empty">조건 통과 종목이 없습니다.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.stocks.map(s => {
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
