"use strict";

// ──────────────────────────────────────────
// 데이터 / 상태
// ──────────────────────────────────────────
let DATA = null;
let CAL_IDX = {}; // 날짜 → 캘린더 인덱스

const params = {
  target: 20,        // 목표수익률(%) · null = 없음
  losscut: 10,       // 로스컷(%) · null = 없음
  holdMode: "months",// 'days' | 'months'
  holdN: 1,
  periodType: "weekly", // 'weekly' | 'monthly'
  market: "ALL",     // 'ALL' | 'KOSPI' | 'KOSDAQ'
  rankLo: 1,
  rankHi: 10,
};

// 추천 전략 스윕 대상 순위 범위
const RECO_RANGES = [
  [1, 3], [1, 5], [1, 10], [1, 20], [1, 7],
  [3, 8], [4, 10], [6, 10], [6, 15], [11, 20],
];
const RECO_MIN_TRADES = 15;

// ──────────────────────────────────────────
// 초기화
// ──────────────────────────────────────────
async function init() {
  bindControls();
  try {
    const res = await fetch("../data/foreign_follow.json?ts=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    DATA = await res.json();
    DATA.calendar.forEach((d, i) => (CAL_IDX[d] = i));
    document.getElementById("updated-at").textContent =
      "업데이트 " + (DATA.updated_at || "—");
    document.getElementById("data-range").textContent =
      `· 백테스트 ${DATA.backtest_start}년 ~ ${DATA.data_last_date} · 시총 상위 ${DATA.cap_top}위 유니버스`;
    render();
  } catch (e) {
    document.getElementById("meta").innerHTML =
      `<div class="reco-empty">데이터를 불러올 수 없습니다: ${e.message}</div>`;
  }
}

// ──────────────────────────────────────────
// 날짜 유틸 (UTC 기준 — 사용자 시간대 무관)
// ──────────────────────────────────────────
function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}
function daysBetween(d1, d2) {
  return Math.round((new Date(d2) - new Date(d1)) / 86400000);
}
function fmtPct(n, digits = 1) {
  if (n == null || isNaN(n)) return "—";
  return (n >= 0 ? "+" : "") + n.toFixed(digits) + "%";
}
function fmtPrice(n) {
  if (!n) return "—";
  return Math.round(n).toLocaleString("ko-KR") + "원";
}
function esc(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// ──────────────────────────────────────────
// 백테스트 핵심
// ──────────────────────────────────────────
// 단일 매매: 진입일 종가 매수 → 목표/로스컷 정확가 체결 또는 만기 종가 매도.
// 반환 status: 'target' | 'losscut' | 'expired' | 'delisted' | 'ongoing' | null(진입불가)
function backtestOne(code, entryDate, rank, p) {
  const st = DATA.stocks[code];
  if (!st) return null;
  const gEntry = CAL_IDX[entryDate];
  if (gEntry == null) return null;
  const li = gEntry - st.s;
  const c = st.c, h = st.h, l = st.l;
  if (li < 0 || li >= c.length) return null;
  const entry = c[li];
  if (!entry) return null; // 진입일 거래정지

  // 종목별 마지막 실거래 인덱스(캐시)
  if (st._last == null) {
    let k = c.length - 1;
    while (k >= 0 && !c[k]) k--;
    st._last = k;
  }
  const lastReal = st._last;
  const calEndLi = DATA.calendar.length - 1 - st.s; // 데이터 최종일의 로컬 인덱스

  const targetP = p.target != null ? entry * (1 + p.target / 100) : Infinity;
  const lossP = p.losscut != null ? entry * (1 - p.losscut / 100) : -Infinity;

  // 보유 한계: 창 종료 글로벌 인덱스(winEndG)와 그 창이 실제로 경과했는지(elapsed)
  let winEndG, elapsed;
  if (p.holdMode === "days") {
    winEndG = gEntry + p.holdN;
    elapsed = winEndG <= DATA.calendar.length - 1;
    if (!elapsed) winEndG = DATA.calendar.length - 1;
  } else {
    const limitDate = addMonths(entryDate, p.holdN);
    elapsed = DATA.calendar[DATA.calendar.length - 1] >= limitDate;
    let gi = gEntry;
    while (gi + 1 < DATA.calendar.length && DATA.calendar[gi + 1] <= limitDate) gi++;
    winEndG = gi;
  }
  const winEndLi = winEndG - st.s;

  const iterEnd = Math.min(winEndLi, lastReal);
  // ── 진입 다음날부터 터치 판정 (매수는 당일 종가) ──
  for (let i = li + 1; i <= iterEnd; i++) {
    if (!c[i]) continue; // 거래정지일 스킵
    const lossHit = p.losscut != null && l[i] <= lossP;
    const tgtHit = p.target != null && h[i] >= targetP;
    // 보수적: 같은 날 동시 터치 시 로스컷 우선
    if (lossHit) {
      return trade(st, code, rank, entryDate, entry, DATA.calendar[st.s + i],
        lossP, -p.losscut, "losscut", i - li);
    }
    if (tgtHit) {
      return trade(st, code, rank, entryDate, entry, DATA.calendar[st.s + i],
        targetP, p.target, "target", i - li);
    }
  }

  // 미체결 → 만기/청산/진행중 판정
  if (elapsed && winEndLi <= lastReal) {
    // 보유창이 경과했고 데이터가 창 종료까지 존재 → 만기 종가 매도
    let ex = winEndLi;
    while (ex > li && !c[ex]) ex--;
    const ret = (c[ex] / entry - 1) * 100;
    return trade(st, code, rank, entryDate, entry, DATA.calendar[st.s + ex],
      c[ex], ret, "expired", ex - li);
  }
  if (lastReal < calEndLi - 3) {
    // 창 종료 전에 거래종료(상폐·장기정지) → 마지막 실거래 종가 청산
    const ret = (c[lastReal] / entry - 1) * 100;
    return trade(st, code, rank, entryDate, entry, DATA.calendar[st.s + lastReal],
      c[lastReal], ret, "delisted", lastReal - li);
  }
  // 보유기간 미도래(최근 매수) → 진행중
  const curRet = (c[lastReal] / entry - 1) * 100;
  return {
    code, name: st.n, market: st.m, rank, entryDate,
    entryPrice: entry, exitDate: null, exitPrice: c[lastReal],
    ret: curRet, curRet, status: "ongoing",
    endDate: DATA.calendar[st.s + lastReal],
  };
}

function trade(st, code, rank, entryDate, entry, exitDate, exitPrice, ret, status, held) {
  return {
    code, name: st.n, market: st.m, rank, entryDate,
    entryPrice: entry, exitDate, exitPrice, ret, status,
    held, endDate: exitDate,
  };
}

// 전체 백테스트: 주어진 설정으로 모든 기간 × 선택 순위 매매 생성
function runBacktest(p) {
  const list = DATA.periods[p.periodType][p.market] || [];
  const lo = Math.max(1, Math.min(20, p.rankLo));
  const hi = Math.max(lo, Math.min(20, p.rankHi));
  const trades = [];
  for (const period of list) {
    const picks = period.r.slice(lo - 1, hi);
    for (let i = 0; i < picks.length; i++) {
      const t = backtestOne(picks[i][0], period.d, lo + i, p);
      if (t) trades.push(t);
    }
  }
  return trades;
}

function summarize(trades) {
  const done = trades.filter((t) => t.status !== "ongoing");
  const ongoing = trades.filter((t) => t.status === "ongoing");
  const rets = done.map((t) => t.ret);
  const wins = done.filter((t) => t.ret > 0).length;
  const avg = rets.length ? rets.reduce((a, b) => a + b, 0) / rets.length : null;
  const cum = rets.length ? rets.reduce((a, b) => a + b, 0) : null;
  const peak = peakConcurrent(
    trades.map((t) => [t.entryDate, t.endDate || t.entryDate])
  );
  return {
    n: trades.length, nDone: done.length, nOngoing: ongoing.length,
    wins, winRate: done.length ? (wins / done.length) * 100 : null,
    avg, cum, peak,
    nTarget: done.filter((t) => t.status === "target").length,
    nLoss: done.filter((t) => t.status === "losscut").length,
  };
}

// 구간 최대 동시 겹침 (이벤트 스위프)
function nextDay(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}
function peakConcurrent(intervals) {
  const ev = [];
  for (const [b, e] of intervals) ev.push([b, 1], [nextDay(e), -1]);
  ev.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] - b[1]));
  let cur = 0, peak = 0;
  for (const e of ev) { cur += e[1]; if (cur > peak) peak = cur; }
  return peak;
}

// ──────────────────────────────────────────
// 렌더링
// ──────────────────────────────────────────
function render() {
  if (!DATA) return;
  syncControlUI();
  const trades = runBacktest(params);
  const s = summarize(trades);
  renderMeta(s);
  renderReco();
  renderPeriodTable("yearly", trades);
  renderPeriodTable("quarterly", trades);
  renderDetail(trades);
}

function renderMeta(s) {
  const cls = (v) => (v == null ? "neutral" : v >= 0 ? "positive" : "negative");
  const cards = [
    ["매수 종목(매매)", `${s.n}건`, "neutral"],
    ["종목당 평균수익률", fmtPct(s.avg), cls(s.avg)],
    ["승률", s.winRate != null ? s.winRate.toFixed(1) + "%" : "—", "neutral"],
    ["누적 수익률(합)", fmtPct(s.cum), cls(s.cum)],
    ["익절 / 손절", `${s.nTarget} / ${s.nLoss}`, "neutral"],
    ["동시보유 최대", `${s.peak}종목`, "neutral"],
    ["진행중", `${s.nOngoing}건`, "neutral"],
  ];
  document.getElementById("meta").innerHTML = cards
    .map(([lb, v, c]) =>
      `<div class="meta-card"><span class="label">${lb}</span><span class="value ${c}">${v}</span></div>`)
    .join("");
}

// 추천 전략: 현재 손익·보유 설정을 고정하고 (집계기준 × 시장 × 순위범위) 스윕
function renderReco() {
  const base = { ...params };
  const results = [];
  for (const pt of ["weekly", "monthly"]) {
    for (const mkt of ["ALL", "KOSPI", "KOSDAQ"]) {
      for (const [lo, hi] of RECO_RANGES) {
        const cfg = { ...base, periodType: pt, market: mkt, rankLo: lo, rankHi: hi };
        const s = summarize(runBacktest(cfg));
        if (s.nDone >= RECO_MIN_TRADES && s.avg != null)
          results.push({ cfg, s });
      }
    }
  }
  results.sort((a, b) => b.s.avg - a.s.avg);
  const top = results.slice(0, 3);
  const el = document.getElementById("reco-cards");
  if (!top.length) {
    el.innerHTML = `<div class="reco-empty">유효 표본(${RECO_MIN_TRADES}건 이상) 전략이 없습니다. 손익·보유 조건을 조정해 보세요.</div>`;
    return;
  }
  const medal = ["🥇", "🥈", "🥉"];
  el.innerHTML = top
    .map((r, i) => {
      const c = r.cfg, s = r.s;
      const ptLabel = c.periodType === "weekly" ? "주간" : "월간";
      const mktLabel = { ALL: "전체", KOSPI: "코스피", KOSDAQ: "코스닥" }[c.market];
      const cls = s.avg >= 0 ? "positive" : "negative";
      return `<div class="reco-card ${i === 0 ? "r1" : ""}" data-idx="${i}"
                 data-cfg='${JSON.stringify(c)}'>
        <span class="rank-badge">${medal[i]}</span>
        <div class="reco-avg ${cls}">${fmtPct(s.avg)}<span class="lbl">종목당 평균</span></div>
        <div class="reco-cfg">${ptLabel} · ${mktLabel} · ${c.rankLo}~${c.rankHi}위</div>
        <div class="reco-sub">
          매매 <b>${s.nDone}건</b> · 승률 <b>${s.winRate.toFixed(0)}%</b><br/>
          누적(합) <b>${fmtPct(s.cum, 0)}</b> · 동시보유 최대 <b>${s.peak}</b>
        </div>
        <div class="apply-hint">▸ 이 전략 적용</div>
      </div>`;
    })
    .join("");
  el.querySelectorAll(".reco-card").forEach((card) => {
    card.addEventListener("click", () => {
      const cfg = JSON.parse(card.dataset.cfg);
      params.periodType = cfg.periodType;
      params.market = cfg.market;
      params.rankLo = cfg.rankLo;
      params.rankHi = cfg.rankHi;
      render();
      document.getElementById("controls").scrollIntoView({ behavior: "smooth", block: "center" });
    });
  });
}

function renderPeriodTable(mode, trades) {
  const body = document.getElementById(mode + "-body");
  if (!trades.length) {
    body.innerHTML = '<tr><td colspan="6" class="empty">해당 조건에 매매가 없습니다</td></tr>';
    return;
  }
  const keyFn =
    mode === "yearly"
      ? (t) => t.entryDate.slice(0, 4)
      : (t) => {
          const [y, m] = t.entryDate.split("-").map(Number);
          return `${y} Q${Math.floor((m - 1) / 3) + 1}`;
        };
  const keys = [...new Set(trades.map(keyFn))].sort();
  const pctTd = (v) =>
    v == null ? '<td class="num">—</td>'
      : `<td class="num ${v >= 0 ? "positive" : "negative"}">${fmtPct(v)}</td>`;
  body.innerHTML = keys
    .map((k) => {
      const grp = trades.filter((t) => keyFn(t) === k);
      const done = grp.filter((t) => t.status !== "ongoing");
      const rets = done.map((t) => t.ret);
      const cum = rets.length ? rets.reduce((a, b) => a + b, 0) : null;
      const avg = rets.length ? cum / rets.length : null;
      const wins = done.filter((t) => t.ret > 0).length;
      const wr = done.length ? ((wins / done.length) * 100).toFixed(0) + "%" : "—";
      const peak = peakConcurrent(grp.map((t) => [t.entryDate, t.endDate || t.entryDate]));
      return `<tr class="year-row">
        <td><strong>${k}</strong></td>
        <td class="num">${grp.length}종목</td>
        <td class="num">${peak}종목</td>
        <td class="num">${wr}</td>
        ${pctTd(avg)}
        ${pctTd(cum)}
      </tr>`;
    })
    .join("");
}

function renderDetail(trades) {
  const body = document.getElementById("detail-body");
  document.getElementById("detail-note").textContent =
    `매매 종목 내역 · ${trades.length}건`;
  if (!trades.length) {
    body.innerHTML = '<tr><td colspan="9" class="empty">해당 조건에 매매가 없습니다</td></tr>';
    return;
  }
  const badge = {
    target: '<span class="badge badge-target">✅ 익절</span>',
    losscut: '<span class="badge badge-losscut">❌ 손절</span>',
    expired: '<span class="badge badge-expired">⏱ 만기청산</span>',
    delisted: '<span class="badge badge-expired">⚠ 상폐/정지</span>',
    ongoing: '<span class="badge badge-ongoing">📌 진행중</span>',
  };
  const rows = [...trades].sort((a, b) =>
    a.entryDate < b.entryDate ? 1 : a.entryDate > b.entryDate ? -1 : a.rank - b.rank
  );
  body.innerHTML = rows
    .map((t) => {
      const retTd =
        t.status === "ongoing"
          ? `<td class="num ${t.ret >= 0 ? "positive" : "negative"}">${fmtPct(t.ret)}<br/><small style="color:var(--text-dim);font-size:10px">평가</small></td>`
          : `<td class="num ${t.ret >= 0 ? "positive" : "negative"}">${fmtPct(t.ret)}</td>`;
      const held = t.exitDate ? daysBetween(t.entryDate, t.exitDate) + "일" : "—";
      return `<tr>
        <td class="num">${t.entryDate}</td>
        <td><strong>${esc(t.name)}</strong></td>
        <td><span class="market-tag">${t.market}</span></td>
        <td class="num">${t.rank}위</td>
        <td class="num">${fmtPrice(t.entryPrice)}</td>
        <td class="num">${t.exitDate || "—"}</td>
        <td class="num">${held}</td>
        ${retTd}
        <td>${badge[t.status] || ""}</td>
      </tr>`;
    })
    .join("");
}

// ──────────────────────────────────────────
// 컨트롤
// ──────────────────────────────────────────
function bindControls() {
  // 목표수익률
  const tin = document.getElementById("target-input");
  const tnone = document.getElementById("target-none");
  tin.addEventListener("change", () => {
    let v = Math.round(+tin.value || 0);
    v = Math.max(1, Math.min(500, v));
    tin.value = v; params.target = v; render();
  });
  tnone.addEventListener("click", () => {
    params.target = params.target == null ? +tin.value || 20 : null; render();
  });

  // 로스컷
  const lin = document.getElementById("losscut-input");
  const lnone = document.getElementById("losscut-none");
  lin.addEventListener("change", () => {
    let v = Math.round(+lin.value || 0);
    v = Math.max(1, Math.min(90, v));
    lin.value = v; params.losscut = v; render();
  });
  lnone.addEventListener("click", () => {
    params.losscut = params.losscut == null ? +lin.value || 10 : null; render();
  });

  // 보유기간 모드 + 값
  bindTabs("hold-mode", (v) => {
    params.holdMode = v;
    const hin = document.getElementById("hold-input");
    if (v === "days") { hin.max = 250; if (params.holdN < 5) { params.holdN = 20; hin.value = 20; } }
    else { hin.max = 24; if (params.holdN > 24) { params.holdN = 3; hin.value = 3; } }
    document.getElementById("hold-unit").textContent = v === "days" ? "거래일" : "개월";
    render();
  });
  const hin = document.getElementById("hold-input");
  hin.addEventListener("change", () => {
    let v = Math.round(+hin.value || 1);
    const max = params.holdMode === "days" ? 250 : 24;
    v = Math.max(1, Math.min(max, v));
    hin.value = v; params.holdN = v; render();
  });

  // 집계 기준 / 시장
  bindTabs("period-type", (v) => { params.periodType = v; render(); });
  bindTabs("market", (v) => { params.market = v; render(); });

  // 순위 범위
  const rlo = document.getElementById("rank-lo");
  const rhi = document.getElementById("rank-hi");
  const applyRank = () => {
    let lo = Math.max(1, Math.min(20, Math.round(+rlo.value || 1)));
    let hi = Math.max(1, Math.min(20, Math.round(+rhi.value || 1)));
    if (lo > hi) [lo, hi] = [hi, lo];
    rlo.value = lo; rhi.value = hi;
    params.rankLo = lo; params.rankHi = hi; render();
  };
  rlo.addEventListener("change", applyRank);
  rhi.addEventListener("change", applyRank);
}

function bindTabs(groupId, onChange) {
  const g = document.getElementById(groupId);
  g.querySelectorAll(".tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      g.querySelectorAll(".tab").forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      onChange(btn.dataset.value);
    });
  });
}

// 상태 → 컨트롤 UI 반영 (추천 적용 시 등)
function syncControlUI() {
  const tin = document.getElementById("target-input");
  const tnone = document.getElementById("target-none");
  tnone.classList.toggle("active", params.target == null);
  tin.disabled = params.target == null;
  tin.parentElement.classList.toggle("dim", params.target == null);
  if (params.target != null) tin.value = params.target;

  const lin = document.getElementById("losscut-input");
  const lnone = document.getElementById("losscut-none");
  lnone.classList.toggle("active", params.losscut == null);
  lin.disabled = params.losscut == null;
  lin.parentElement.classList.toggle("dim", params.losscut == null);
  if (params.losscut != null) lin.value = params.losscut;

  document.getElementById("hold-input").value = params.holdN;
  document.getElementById("hold-unit").textContent =
    params.holdMode === "days" ? "거래일" : "개월";
  setTabActive("hold-mode", params.holdMode);
  setTabActive("period-type", params.periodType);
  setTabActive("market", params.market);

  document.getElementById("rank-lo").value = params.rankLo;
  document.getElementById("rank-hi").value = params.rankHi;
  const n = params.rankHi - params.rankLo + 1;
  const rc = document.getElementById("rank-count");
  rc.textContent = `${n}종목/기간`;
  rc.classList.toggle("rank-warn", n > 15);
}

function setTabActive(groupId, value) {
  const g = document.getElementById(groupId);
  g.querySelectorAll(".tab").forEach((b) =>
    b.classList.toggle("active", b.dataset.value === value)
  );
}

document.addEventListener("DOMContentLoaded", init);
