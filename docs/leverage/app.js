"use strict";

// ════════════════════════════════════════════════════════════
//  나스닥100 레버리지 전략 추적기
//  - 신호 자산: QQQ 종가 / 지표: SMA200(close) / 밴드: ±1% (이력현상)
//  - 상태머신: CASH→TQQQ (close > SMA*1.01), TQQQ→CASH (close < SMA*0.99)
//  - 체결: 종가로 신호 확정 → 다음 거래일 (성과 시뮬레이션에 반영)
//  - 데이터: Twelve Data 일봉(EOD), CORS 허용. QQQ는 demo 키로도 동작,
//            TQQQ/QLD는 사용자 무료 키 필요. localStorage로 세션당 1회만 갱신.
// ════════════════════════════════════════════════════════════

const SMA_N = 200;
const BAND = 0.01;            // ±1%
const SWITCH_COST = 0.0005;   // 5bp
const KEY_STORE = "lev:apikey";
const CACHE_PREFIX = "lev:td:";

// 모듈 상태 (성과 재계산용 캐시)
let lastSeries = null;        // { qqq, tqqq, qld } (완료 세션만, 오래된→최신)
let perfChart = null;

// ──────────────────────────────────────────
//  유틸: 포맷
// ──────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const fmtUsd = (v) => "$" + v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtPct = (v, dp = 2) => (v >= 0 ? "+" : "") + v.toFixed(dp) + "%";
function fmtMoney(v) { return Math.round(v).toLocaleString("ko-KR") + "원"; }
function fmtMoneyShort(v) {
  const a = Math.abs(v);
  if (a >= 1e8) return (v / 1e8).toFixed(1).replace(/\.0$/, "") + "억";
  if (a >= 1e4) return Math.round(v / 1e4).toLocaleString("ko-KR") + "만";
  return Math.round(v).toLocaleString("ko-KR");
}
function fmtTime(ts) {
  try { return new Date(ts).toLocaleString("ko-KR", { dateStyle: "short", timeStyle: "short" }); }
  catch (e) { return "—"; }
}

// ──────────────────────────────────────────
//  유틸: 미국 동부시간(ET) — 마지막 "완료된" 거래일
//  (휴장일은 미반영. 데이터의 실제 최신 종가일을 화면에 별도 표기)
// ──────────────────────────────────────────
function nowETParts(now = new Date()) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false, weekday: "short",
  });
  const p = {};
  for (const part of fmt.formatToParts(now)) p[part.type] = part.value;
  const wmap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
  let hour = parseInt(p.hour, 10);
  if (hour === 24) hour = 0;
  return { y: +p.year, m: +p.month, d: +p.day, hour, min: +p.minute, weekday: wmap[p.weekday], ymd: `${p.year}-${p.month}-${p.day}` };
}

function lastCompletedSessionET(now = new Date()) {
  const p = nowETParts(now);
  const afterClose = p.hour > 16 || (p.hour === 16 && p.min >= 15); // 16:15 ET 여유
  let cur = new Date(Date.UTC(p.y, p.m - 1, p.d, 12, 0, 0));
  let wd = p.weekday;
  const isWeekend = (w) => w === 0 || w === 6;
  const stepBack = () => { cur = new Date(cur.getTime() - 86400000); wd = (wd + 6) % 7; };
  if (isWeekend(wd)) { do { stepBack(); } while (isWeekend(wd)); }        // 주말 → 직전 금요일
  else if (!afterClose) { do { stepBack(); } while (isWeekend(wd)); }     // 장중/장전 → 직전 거래일
  const yy = cur.getUTCFullYear();
  const mm = String(cur.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(cur.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

// 완료 세션만 (장중 형성 중인 당일 바 제거)
function filterCompleted(values) {
  const expected = lastCompletedSessionET();
  return values.filter((v) => v.d <= expected);
}

// ──────────────────────────────────────────
//  API 키 / 캐시
// ──────────────────────────────────────────
function getStoredKey() {
  try { return (localStorage.getItem(KEY_STORE) || "").trim(); } catch (e) { return ""; }
}
function cacheKey(symbol, tag) { return CACHE_PREFIX + symbol + ":" + tag; }
function loadCache(symbol, tag) {
  try { return JSON.parse(localStorage.getItem(cacheKey(symbol, tag))); } catch (e) { return null; }
}
function saveCache(symbol, tag, obj) {
  try { localStorage.setItem(cacheKey(symbol, tag), JSON.stringify(obj)); } catch (e) { /* quota */ }
}
function cacheFresh(cache, expected) {
  if (!cache || !Array.isArray(cache.values) || !cache.values.length) return false;
  if (cache.latestBar >= expected) return true;        // 이미 최신 완료 바 보유
  if (cache.fetchedSession === expected) return true;  // 이번 세션은 이미 시도함(휴장/지연)
  return false;
}

// ──────────────────────────────────────────
//  Twelve Data fetch
// ──────────────────────────────────────────
async function fetchTD(symbol, apikey, outputsize) {
  const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}` +
              `&interval=1day&outputsize=${outputsize}&apikey=${encodeURIComponent(apikey)}`;
  const res = await fetch(url);
  let data;
  try { data = await res.json(); } catch (e) { throw new Error("응답 파싱 실패 (HTTP " + res.status + ")"); }
  if (!data || data.status === "error" || !Array.isArray(data.values)) {
    const err = new Error((data && data.message) ? data.message : "데이터 오류 (HTTP " + res.status + ")");
    err.code = data && data.code;
    throw err;
  }
  // values: 최신→과거 → 과거→최신으로 뒤집고 파싱
  return data.values
    .map((v) => ({ d: v.datetime, c: parseFloat(v.close) }))
    .filter((v) => v.d && isFinite(v.c) && v.c > 0)
    .reverse();
}

// 캐시 우선 + 필요 시 1회 fetch
async function getSeries(symbol, outputsize, force) {
  const userKey = getStoredKey();
  const apikey = userKey || "demo";
  const tag = userKey ? "user" : "demo";
  const expected = lastCompletedSessionET();
  let cache = loadCache(symbol, tag);
  if (!force && cacheFresh(cache, expected)) {
    return { values: cache.values, latestBar: cache.latestBar, fetchedAt: cache.fetchedAt, cached: true };
  }
  const values = await fetchTD(symbol, apikey, outputsize);
  const latestBar = values.length ? values[values.length - 1].d : null;
  const fetchedAt = Date.now();
  saveCache(symbol, tag, { values, latestBar, fetchedSession: expected, fetchedAt });
  return { values, latestBar, fetchedAt, cached: false };
}

// ──────────────────────────────────────────
//  신호 계산 (SMA200 + ±1% 밴드 상태머신)
// ──────────────────────────────────────────
function computeSignal(closes) {
  const n = closes.length;
  if (n < SMA_N) return null;

  const sma = new Array(n).fill(null);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    sum += closes[i].c;
    if (i >= SMA_N) sum -= closes[i - SMA_N].c;
    if (i >= SMA_N - 1) sma[i] = sum / SMA_N;
  }

  let state = "CASH";
  let lastSwitchIdx = -1;
  let lastTo = null;
  for (let i = SMA_N - 1; i < n; i++) {
    const c = closes[i].c, s = sma[i];
    if (state === "CASH" && c > s * (1 + BAND)) { state = "TQQQ"; lastSwitchIdx = i; lastTo = "TQQQ"; }
    else if (state === "TQQQ" && c < s * (1 - BAND)) { state = "CASH"; lastSwitchIdx = i; lastTo = "CASH"; }
  }

  const last = n - 1;
  return {
    state, closes, lastIdx: last,
    close: closes[last].c, asOf: closes[last].d, smaNow: sma[last],
    buyLine: sma[last] * (1 + BAND), sellLine: sma[last] * (1 - BAND),
    lastSwitchIdx, lastTo,
  };
}

// 성과 시뮬레이션용: 날짜→(종가 처리 후) 상태
function buildStateByDate(closes) {
  const n = closes.length;
  const map = new Map();
  let sum = 0, state = "CASH";
  for (let i = 0; i < n; i++) {
    sum += closes[i].c;
    if (i >= SMA_N) sum -= closes[i - SMA_N].c;
    if (i >= SMA_N - 1) {
      const s = sum / SMA_N, c = closes[i].c;
      if (state === "CASH" && c > s * (1 + BAND)) state = "TQQQ";
      else if (state === "TQQQ" && c < s * (1 - BAND)) state = "CASH";
    }
    map.set(closes[i].d, state);
  }
  return map;
}

// ──────────────────────────────────────────
//  대시보드 렌더
// ──────────────────────────────────────────
function renderDashboard(sig, meta) {
  const hero = $("signal-hero");
  const isTqqq = sig.state === "TQQQ";

  hero.className = "signal-hero " + (isTqqq ? "state-tqqq" : "state-cash");
  $("signal-dot").textContent = isTqqq ? "🟢" : "⚪";
  $("signal-name").textContent = isTqqq ? "TQQQ 보유" : "현금";

  // 전환까지 여유
  let cushVal, cushNote, cushClass;
  if (isTqqq) {
    const pct = (sig.close - sig.sellLine) / sig.close * 100;
    cushVal = "▼ " + pct.toFixed(1) + "%";
    cushNote = `QQQ가 약 ${pct.toFixed(1)}% 더 하락하면 현금 전환 (매도선 도달)`;
    cushClass = pct < 1.5 ? "warn" : "ok";
  } else {
    const pct = (sig.buyLine - sig.close) / sig.close * 100;
    cushVal = "▲ " + pct.toFixed(1) + "%";
    cushNote = `QQQ가 약 ${pct.toFixed(1)}% 더 상승하면 TQQQ 전환 (매수선 도달)`;
    cushClass = pct < 1.5 ? "warn" : "";
  }
  const cv = $("cushion-val");
  cv.textContent = cushVal;
  cv.className = "cushion-val " + cushClass;
  $("cushion-note").textContent = cushNote;

  // 게이지
  renderGauge(sig);

  // 지표 카드
  const todayET = nowETParts().ymd;
  const delay = sig.asOf === todayET ? "오늘 종가 · 장 마감 반영" : "직전 거래일 종가";
  $("m-close").textContent = fmtUsd(sig.close);
  $("m-close-date").textContent = sig.asOf + " · " + delay;
  $("m-sma").textContent = fmtUsd(sig.smaNow);
  $("m-buy").textContent = fmtUsd(sig.buyLine);
  $("m-sell").textContent = fmtUsd(sig.sellLine);

  const vs = (sig.close - sig.smaNow) / sig.smaNow * 100;
  const vsEl = $("m-vssma");
  vsEl.textContent = fmtPct(vs);
  vsEl.className = "value " + (vs >= 0 ? "buy" : "sell");

  if (sig.lastSwitchIdx >= 0) {
    const swDate = sig.closes[sig.lastSwitchIdx].d;
    const sessions = sig.lastIdx - sig.lastSwitchIdx;
    const calDays = Math.round((new Date(sig.asOf) - new Date(swDate)) / 86400000);
    $("m-lastswitch").textContent = swDate + " · " + (sig.lastTo === "TQQQ" ? "TQQQ 전환" : "현금 전환");
    $("m-held").textContent = `${calDays}일 (${sessions}거래일) 유지 중`;
  } else {
    $("m-lastswitch").textContent = "기록 구간 내 없음";
    $("m-held").textContent = "상태 계속 유지";
  }

  // 데이터 상태
  const srcLabel = meta.cached ? "캐시" : "신규 수신";
  $("ds-left").innerHTML =
    `데이터: <strong>Twelve Data</strong> 일봉(EOD) · 기준일 <strong>${sig.asOf}</strong> · ` +
    `<span class="ds-src">${srcLabel}</span> · 마지막 갱신 ${fmtTime(meta.fetchedAt)} · ` +
    `미국장 마감 후 1회 갱신(실시간 아님)`;
}

function renderGauge(sig) {
  const { close, smaNow, buyLine, sellLine, state } = sig;
  // 고정 ±3% 창: 밴드(±1%) 라벨이 항상 읽히도록. 가격은 창 밖이면 가장자리에 고정.
  const min = smaNow * 0.97, max = smaNow * 1.03;
  const clamp = (x) => Math.max(0, Math.min(100, x));
  const raw = (v) => (v - min) / (max - min) * 100;
  const pos = (v) => clamp(raw(v));
  const pSell = pos(sellLine), pSma = pos(smaNow), pBuy = pos(buyLine);
  const rawMark = raw(close), pMark = clamp(rawMark);
  const offscale = rawMark < 0 ? "◀ " : rawMark > 100 ? "▶ " : "";
  const markerClass = state === "TQQQ" ? "tqqq" : "cash";
  const vs = (close - smaNow) / smaNow * 100;

  $("gauge-top").innerHTML =
    `<div class="gauge-marker-label ${markerClass}" style="left:${clamp(Math.max(8, Math.min(92, pMark)))}%">` +
    `<span class="dot">●</span> ${fmtUsd(close)} <span class="pct">(${fmtPct(vs, 1)})</span> ${offscale}</div>`;

  $("gauge-track").innerHTML =
    `<div class="gauge-zone zone-cash" style="left:0%;width:${pSell}%"></div>` +
    `<div class="gauge-zone zone-hold" style="left:${pSell}%;width:${pBuy - pSell}%"></div>` +
    `<div class="gauge-zone zone-tqqq" style="left:${pBuy}%;width:${100 - pBuy}%"></div>` +
    `<div class="gauge-tick sell" style="left:${pSell}%"></div>` +
    `<div class="gauge-tick sma" style="left:${pSma}%"></div>` +
    `<div class="gauge-tick buy" style="left:${pBuy}%"></div>` +
    `<div class="gauge-marker ${markerClass}" style="left:${pMark}%" title="현재 QQQ 종가 ${fmtUsd(close)}"></div>`;

  $("gauge-axis").innerHTML =
    `<div class="axis-item sell" style="left:${pSell}%"><span class="k">매도선</span><br><span class="v">${fmtUsd(sellLine)}</span></div>` +
    `<div class="axis-item" style="left:${pSma}%"><span class="k">SMA200</span><br><span class="v">${fmtUsd(smaNow)}</span></div>` +
    `<div class="axis-item buy" style="left:${pBuy}%"><span class="k">매수선</span><br><span class="v">${fmtUsd(buyLine)}</span></div>`;
}

function showSignalError(msg) {
  const hero = $("signal-hero");
  hero.className = "signal-hero state-cash";
  $("signal-dot").textContent = "⚠️";
  $("signal-name").textContent = "데이터 오류";
  $("cushion-val").textContent = "—";
  $("cushion-note").textContent = "";
  $("ds-left").textContent = "데이터를 불러올 수 없습니다: " + msg;
}

// ──────────────────────────────────────────
//  성과 추적 (스위칭 / QLD / 50:50)
// ──────────────────────────────────────────
function simulate(qqq, tqqq, qld, startDate, seed) {
  const tMap = new Map(tqqq.map((x) => [x.d, x.c]));
  const lMap = new Map(qld.map((x) => [x.d, x.c]));
  const stateByDate = buildStateByDate(qqq);

  let eqSwitch = seed, eqQld = seed;        // 단일 전략 (전체 시드)
  let halfSwitch = seed / 2, halfQld = seed / 2; // 50:50 독립 버킷
  let prevAsset = null, prevT = null, prevL = null, started = false;
  const out = [];

  for (let i = 0; i < qqq.length; i++) {
    const d = qqq[i].d;
    if (d < startDate) continue;
    if (!tMap.has(d) || !lMap.has(d)) continue;
    const tC = tMap.get(d), lC = lMap.get(d);

    if (!started) {
      const pd = i > 0 ? qqq[i - 1].d : null;
      prevAsset = (pd && stateByDate.has(pd)) ? stateByDate.get(pd) : "CASH";
      prevT = tC; prevL = lC; started = true;
      out.push({ d, sw: eqSwitch, qld: eqQld, blend: halfSwitch + halfQld });
      continue;
    }

    const pd = qqq[i - 1].d;
    const assetToday = stateByDate.has(pd) ? stateByDate.get(pd) : prevAsset;
    const tRet = tC / prevT - 1;
    const lRet = lC / prevL - 1;
    const swRet = assetToday === "TQQQ" ? tRet : 0;

    if (assetToday !== prevAsset) { eqSwitch *= (1 - SWITCH_COST); halfSwitch *= (1 - SWITCH_COST); }
    eqSwitch *= (1 + swRet);  halfSwitch *= (1 + swRet);
    eqQld   *= (1 + lRet);    halfQld   *= (1 + lRet);

    prevAsset = assetToday; prevT = tC; prevL = lC;
    out.push({ d, sw: eqSwitch, qld: eqQld, blend: halfSwitch + halfQld });
  }
  return out;
}

function maxDrawdown(series) {
  let peak = -Infinity, mdd = 0;
  for (const v of series) { if (v > peak) peak = v; const dd = v / peak - 1; if (dd < mdd) mdd = dd; }
  return mdd;
}

function statBlock(name, colorVar, key, out, seed) {
  const series = out.map((p) => p[key]);
  const final = series[series.length - 1];
  const totRet = final / seed - 1;
  const days = (new Date(out[out.length - 1].d) - new Date(out[0].d)) / 86400000;
  const years = days / 365.25;
  const cagr = years > 0.05 ? Math.pow(final / seed, 1 / years) - 1 : 0;
  const mdd = maxDrawdown(series);
  const cls = (v) => (v >= 0 ? "positive" : "negative");
  return `<div class="perf-card">
    <div class="pc-name"><i style="background:${colorVar}"></i>${name}</div>
    <div class="pc-row"><span class="k">최종 자산</span><span class="v">${fmtMoney(final)}</span></div>
    <div class="pc-row"><span class="k">총 수익</span><span class="v ${cls(totRet)}">${fmtPct(totRet * 100, 1)}</span></div>
    <div class="pc-row"><span class="k">CAGR</span><span class="v ${cls(cagr)}">${fmtPct(cagr * 100, 1)}</span></div>
    <div class="pc-row"><span class="k">최대낙폭</span><span class="v negative">${(mdd * 100).toFixed(1)}%</span></div>
  </div>`;
}

function downsample(arr, maxPts) {
  if (arr.length <= maxPts) return arr;
  const step = Math.ceil(arr.length / maxPts);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
}

function recomputePerf() {
  if (!lastSeries) return;
  const msg = $("perf-msg");
  const seed = Math.max(1, parseFloat($("perf-seed").value) || 10000000);
  let start = $("perf-start").value;
  if (!start) start = lastSeries.qqq[0] ? lastSeries.qqq[0].d : "2016-01-01";

  const out = simulate(lastSeries.qqq, lastSeries.tqqq, lastSeries.qld, start, seed);
  if (out.length < 2) {
    $("chart-wrap").hidden = true;
    $("perf-summary").hidden = true;
    msg.hidden = false;
    msg.textContent = "선택한 시작일에 해당하는 데이터가 부족합니다. 더 이른 날짜를 선택하세요.";
    return;
  }

  // 요약 카드
  const sum = $("perf-summary");
  sum.innerHTML =
    statBlock("스위칭(TQQQ↔현금)", "#16a34a", "sw", out, seed) +
    statBlock("QLD 바이앤홀드", "#3b82f6", "qld", out, seed) +
    statBlock("50:50 혼합", "#d97706", "blend", out, seed);
  sum.hidden = false;

  // 차트
  $("chart-wrap").hidden = false;
  msg.hidden = false;
  const actualStart = out[0].d;
  const note = actualStart !== start
    ? `※ 데이터 가용 범위에 맞춰 시작일을 ${actualStart}로 조정했습니다 (TQQQ 상장 2010-02). `
    : "";
  msg.innerHTML = `<span style="color:var(--text-dim)">${note}${actualStart} ~ ${out[out.length - 1].d} · 일별 종가 기준 · 세금·환율 미반영</span>`;

  const pts = downsample(out, 700);
  const labels = pts.map((p) => p.d);
  const mkDs = (key, label, bc) => ({
    label, data: pts.map((p) => p[key]),
    borderColor: bc, backgroundColor: "transparent",
    borderWidth: 2, pointRadius: 0, tension: 0.12, fill: false,
  });

  Chart.defaults.color = "#8a93a6";
  Chart.defaults.borderColor = "#2a3142";
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Pretendard', sans-serif";

  if (perfChart) perfChart.destroy();
  perfChart = new Chart($("perf-chart").getContext("2d"), {
    type: "line",
    data: { labels, datasets: [
      mkDs("sw", "스위칭(TQQQ↔현금)", "#16a34a"),
      mkDs("qld", "QLD 바이앤홀드", "#3b82f6"),
      mkDs("blend", "50:50 혼합", "#d97706"),
    ] },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 14, boxHeight: 14, padding: 12 } },
        tooltip: {
          backgroundColor: "#1a1f2e", borderColor: "#2a3142", borderWidth: 1, padding: 10,
          callbacks: { label: (c) => `${c.dataset.label}: ${fmtMoney(c.parsed.y)}` },
        },
      },
      scales: {
        x: { grid: { display: false }, ticks: { maxTicksLimit: 8, autoSkip: true, maxRotation: 0 } },
        y: { grid: { color: "rgba(42,49,66,0.6)" }, ticks: { callback: (v) => fmtMoneyShort(v) } },
      },
    },
  });
}

function showPerfNeedsKey() {
  $("chart-wrap").hidden = true;
  $("perf-summary").hidden = true;
  const msg = $("perf-msg");
  msg.hidden = false;
  msg.innerHTML = "성과 비교 차트는 <strong>TQQQ·QLD</strong> 일별 종가가 필요합니다. " +
                  "아래 <strong>데이터 설정</strong>에서 무료 API 키를 입력하면 표시됩니다.";
}

// ──────────────────────────────────────────
//  메인 실행
// ──────────────────────────────────────────
async function run(force) {
  const userKey = getStoredKey();
  try {
    // QQQ (신호 + 성과). 키 있으면 긴 히스토리(차트용), 없으면 600일(대시보드용)
    const qOut = userKey ? 5000 : 600;
    const qqqRes = await getSeries("QQQ", qOut, force);
    const qqqClosed = filterCompleted(qqqRes.values);
    const sig = computeSignal(qqqClosed);
    if (!sig) { showSignalError("SMA200 계산에 필요한 과거 데이터(200일+)가 부족합니다."); return; }
    renderDashboard(sig, qqqRes);

    // 성과 추적 (TQQQ/QLD는 사용자 키 필요)
    if (userKey) {
      try {
        const [tRes, lRes] = await Promise.all([
          getSeries("TQQQ", 5000, force),
          getSeries("QLD", 5000, force),
        ]);
        lastSeries = { qqq: qqqClosed, tqqq: filterCompleted(tRes.values), qld: filterCompleted(lRes.values) };
        recomputePerf();
        setKeyStatus("ok", "✓ 키 저장됨 — TQQQ·QLD 포함 전체 데이터 사용 중");
      } catch (e) {
        lastSeries = null;
        showPerfNeedsKey();
        setKeyStatus("err", "키로 TQQQ/QLD를 불러오지 못했습니다: " + e.message);
      }
    } else {
      lastSeries = null;
      showPerfNeedsKey();
      setKeyStatus("", "현재 키 없음 — 신호(QQQ)는 demo 데이터로 동작합니다.");
    }
  } catch (e) {
    showSignalError(e.message);
  }
}

// ──────────────────────────────────────────
//  API 키 UI
// ──────────────────────────────────────────
function setKeyStatus(cls, text) {
  const el = $("key-status");
  el.className = "key-status " + cls;
  el.textContent = text;
}

function saveKey() {
  const v = $("api-key").value.trim();
  if (!v) { setKeyStatus("err", "키를 입력하세요."); return; }
  try { localStorage.setItem(KEY_STORE, v); } catch (e) {}
  setKeyStatus("ok", "저장됨 — 데이터를 불러오는 중…");
  run(true);
}

function clearKey() {
  try { localStorage.removeItem(KEY_STORE); } catch (e) {}
  $("api-key").value = "";
  setKeyStatus("", "키 삭제됨 — 신호(QQQ)는 demo 데이터로 계속 동작합니다.");
  run(true);
}

// ──────────────────────────────────────────
//  초기화
// ──────────────────────────────────────────
function init() {
  // 저장된 키 채우기
  const k = getStoredKey();
  if (k) $("api-key").value = k;

  // 기본 시작일: 3년 전
  const d = new Date();
  d.setFullYear(d.getFullYear() - 3);
  const def = d.toISOString().slice(0, 10);
  const startEl = $("perf-start");
  startEl.value = def;
  startEl.max = nowETParts().ymd;
  startEl.min = "2010-02-12"; // TQQQ 상장일

  // 이벤트 바인딩
  $("refresh-btn").addEventListener("click", () => run(true));
  $("save-key-btn").addEventListener("click", saveKey);
  $("clear-key-btn").addEventListener("click", clearKey);
  $("api-key").addEventListener("keydown", (e) => { if (e.key === "Enter") saveKey(); });
  $("perf-start").addEventListener("change", recomputePerf);
  $("perf-seed").addEventListener("change", recomputePerf);

  run(false);
}

document.addEventListener("DOMContentLoaded", init);
