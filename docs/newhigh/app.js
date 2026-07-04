/* KOSPI 52주 신고가 주도주 스크리너 */
(async function () {
  const fmt = (n) => Number(n).toLocaleString("ko-KR");
  const pct = (n) => (n > 0 ? "+" : "") + Number(n).toFixed(1) + "%";
  const cls = (n) => (n >= 0 ? "pos" : "neg");

  let data;
  try {
    const res = await fetch("../data/newhigh_signals.json?nocache=" + Date.now());
    data = await res.json();
  } catch (e) {
    document.getElementById("updated-at").textContent = "데이터를 불러오지 못했습니다.";
    return;
  }

  document.getElementById("updated-at").textContent =
    `업데이트 ${data.updated_at} · 시세 기준일 ${data.data_last_date}`;

  /* ---------- ① 이번 주 매수 신호 ---------- */
  document.getElementById("signal-week").textContent = `(${data.complete_week} 마감 주)`;
  const sigBody = document.getElementById("signal-body");
  const newSignals = data.new_signals || [];
  if (newSignals.length === 0) {
    sigBody.innerHTML = `<div class="signal-empty">
      이번 주 신호 없음 — 조건(주간 거래대금 상위 ${data.params.amt_rank}위 ·
      시총 ${data.params.cap_lo}~${data.params.cap_hi}위 · 52주 신고가 종가 마감)을
      모두 충족한 종목이 없습니다.</div>`;
  } else {
    sigBody.innerHTML = `<div class="signal-cards">` + newSignals.map((s) => `
      <div class="signal-card">
        <div><span class="stock-name">${s.name}</span><span class="stock-code">${s.code}</span></div>
        <div class="buy-price">${fmt(s.entry_price)}원 <small>매수가 (${s.entry_date} 종가)</small></div>
        <div class="level-grid">
          <div class="level stop"><span class="lv-label">손절가 (-30%)</span>
            <span class="lv-value">${fmt(s.stop_price)}</span></div>
          <div class="level t1"><span class="lv-label">1차 목표 (+45% 절반)</span>
            <span class="lv-value">${fmt(s.target1_price)}</span></div>
          <div class="level t2"><span class="lv-label">2차 목표 (+90%)</span>
            <span class="lv-value">${fmt(s.target2_price)}</span></div>
        </div>
      </div>`).join("") + `</div>`;
  }

  /* ---------- ② 보유 중인 종목 ---------- */
  const holdings = data.holdings || [];
  document.getElementById("holdings-count").textContent = `(${holdings.length}종목)`;
  const holdBody = document.getElementById("holdings-body");
  if (holdings.length === 0) {
    holdBody.innerHTML = `<div class="signal-empty">현재 보유 중인 종목이 없습니다.</div>`;
  } else {
    holdBody.innerHTML = `<div class="holding-cards">` + holdings.map((h) => `
      <div class="holding-card">
        <div class="top-row">
          <div><span class="stock-name">${h.name}</span><span class="stock-code">${h.code}</span>
            ${h.partial_done ? '<span class="partial-badge">1차 익절 완료</span>' : ""}</div>
          <span class="cur-ret ${cls(h.current_ret)}">${pct(h.current_ret)}</span>
        </div>
        <div class="sub-row">
          ${h.entry_date} 매수 ${fmt(h.entry_price)}원 · 현재 ${fmt(h.current_price)}원 ·
          만기 ${h.expiry_date} (D-${h.days_left})
          ${h.partial_done ? ` · ${h.partial_date} 절반 익절` : ""}
        </div>
        <div class="level-grid">
          <div class="level stop"><span class="lv-label">손절가</span>
            <span class="lv-value">${fmt(h.stop_price)}</span></div>
          <div class="level t1"><span class="lv-label">1차 목표${h.partial_done ? " ✓" : ""}</span>
            <span class="lv-value">${fmt(h.target1_price)}</span></div>
          <div class="level t2"><span class="lv-label">2차 목표</span>
            <span class="lv-value">${fmt(h.target2_price)}</span></div>
        </div>
      </div>`).join("") + `</div>`;
  }

  /* ---------- ③ 요약 통계 ---------- */
  const s = data.summary || {};
  document.getElementById("stats-grid").innerHTML = [
    ["누적 수익률", pct(s.cum_ret), "green", `${s.backtest_start} ~ 현재 · 동일금액 산술합`],
    ["종목당 평균 수익률", pct(s.avg_ret), "green", `청산 ${s.n_closed}건 기준`],
    ["승률", `${s.win_rate}%`, "", `${s.wins}승 ${s.n_closed - s.wins}패`],
    ["최대 동시 보유", `${s.max_concurrent}종목`, "", `평균 보유 ${s.avg_hold_days}일`],
    ["1차 익절(+45%) 도달", `${s.partial_count}건`, "", `2차(+90%) 완주 ${s.n_tp}건`],
    ["손절(-30%)", `${s.n_stop}건`, "", `현재 보유 ${s.n_open}종목`],
  ].map(([label, value, color, sub]) => `
    <div class="stat-card">
      <span class="label">${label}</span>
      <span class="value ${color}">${value}</span>
      <div class="sub">${sub}</div>
    </div>`).join("");

  /* ---------- ④ 연별 / 분기별 ---------- */
  const periodTbody = document.querySelector("#period-table tbody");
  function renderPeriod(mode) {
    const rows = data[mode] || [];
    periodTbody.innerHTML = rows.map((r) => `
      <tr>
        <td>${r.period}</td>
        <td>${r.n}건</td>
        <td>${r.n ? Math.round((r.wins / r.n) * 100) : 0}%</td>
        <td class="${cls(r.avg)}">${pct(r.avg)}</td>
        <td class="${cls(r.total)}">${pct(r.total)}</td>
      </tr>`).join("");
  }
  renderPeriod("yearly");
  document.getElementById("period-toggle").addEventListener("click", (e) => {
    const btn = e.target.closest(".toggle-btn");
    if (!btn) return;
    document.querySelectorAll(".toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    renderPeriod(btn.dataset.mode);
  });

  /* ---------- ⑤ 전체 매매 이력 ---------- */
  const closed = data.closed || [];
  document.getElementById("history-count").textContent = `(청산 ${closed.length}건)`;
  const holdDays = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);
  document.querySelector("#history-table tbody").innerHTML = closed.map((t) => `
    <tr>
      <td>${t.entry_date}</td>
      <td>${t.name}</td>
      <td>${fmt(t.entry_price)}</td>
      <td>${t.exit_date}</td>
      <td>${holdDays(t.entry_date, t.exit_date)}일</td>
      <td class="reason-cell">${t.reason}</td>
      <td class="${cls(t.ret)}"><strong>${pct(t.ret)}</strong></td>
    </tr>`).join("");
})();
