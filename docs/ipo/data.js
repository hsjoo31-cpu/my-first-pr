"use strict";

// ──────────────────────────────────────────
// 포스트 IPO 데이터 관리 — 전체 종목 최신 상장순
// 확약해제일(15일·1개월·3개월·6개월)별 종가 표시
// ──────────────────────────────────────────

const LOCKUPS = [
  { key: "d15", label: "15일", addFn: (d) => addDays(d, 15) },
  { key: "m1",  label: "1개월", addFn: (d) => addMonths(d, 1) },
  { key: "m3",  label: "3개월", addFn: (d) => addMonths(d, 3) },
  { key: "m6",  label: "6개월", addFn: (d) => addMonths(d, 6) },
];

async function init() {
  const body = document.getElementById("data-body");
  try {
    const res = await fetch("../data/ipo_data.json?ts=" + Date.now());
    if (!res.ok) throw new Error("HTTP " + res.status);
    const data = await res.json();

    const stocks = (data.stocks || [])
      .map((s) => ({
        ...s,
        prices: (s.prices || []).filter(
          (r) => r.o > 0 && r.h > 0 && r.l > 0 && r.c > 0
        ),
      }))
      .filter((s) => s.prices.length > 0)
      // 최신 상장순 (위일수록 최근)
      .sort((a, b) =>
        a.ipo_date > b.ipo_date ? -1 : a.ipo_date < b.ipo_date ? 1 : 0
      );

    // 전체 데이터의 마지막 거래일 — '미도래' 판정 기준
    const globalLast = stocks.reduce((max, s) => {
      const last = s.prices[s.prices.length - 1].d;
      return last > max ? last : max;
    }, "0000-00-00");

    document.getElementById("updated-at").textContent = data.updated_at || "—";
    document.getElementById("stock-count").textContent = stocks.length + "종목";

    body.innerHTML = stocks.map((s) => buildRow(s, globalLast)).join("");
  } catch (e) {
    body.innerHTML = `<tr><td colspan="9" class="empty">데이터를 불러올 수 없습니다: ${e.message}</td></tr>`;
  }
}

function buildRow(s, globalLast) {
  const listingOpen = s.prices[0].o;
  const lockupCells = LOCKUPS.map((lu) => {
    const releaseDate = lu.addFn(s.ipo_date);
    return lockupCell(s.prices, releaseDate, globalLast);
  }).join("");

  return `<tr>
    <td><strong>${esc(s.name)}</strong><br/><small class="dim">${esc(s.ticker)}</small></td>
    <td><span class="market-tag">${esc(s.market)}</span></td>
    <td class="num">${s.ipo_date}</td>
    <td class="num">${fmtPrice(s.ipo_price)}</td>
    <td class="num">${fmtPrice(listingOpen)}</td>
    ${lockupCells}
  </tr>`;
}

// 해제일 이후 첫 거래일의 종가 셀
function lockupCell(prices, releaseDate, globalLast) {
  if (releaseDate > globalLast) {
    return `<td class="num"><span class="dim">미도래</span><br/><small class="dim">${releaseDate}</small></td>`;
  }
  const row = prices.find((r) => r.d >= releaseDate);
  if (!row) {
    return `<td class="num"><span class="dim">—</span><br/><small class="dim">${releaseDate}</small></td>`;
  }
  return `<td class="num">${fmtPrice(row.c)}<br/><small class="dim">${row.d}</small></td>`;
}

// ── 날짜 유틸 (Date.UTC 기준 — 시간대 무관) ──
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function addMonths(dateStr, months) {
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1 + months, d)).toISOString().slice(0, 10);
}

// ── 표시 유틸 ──
function fmtPrice(n) {
  if (!n) return "—";
  return n.toLocaleString("ko-KR") + "원";
}

function esc(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

document.addEventListener("DOMContentLoaded", init);
