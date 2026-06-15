/**
 * verify-chart-search-smoke.ts — 메인 차트 종목 검색 + 임의 종목 차트(합성ID) 스모크.
 *   대시보드를 임시포트로 띄우고 /api/search·/api/candles(sym:BROKER:SYMBOL)를 직접 호출.
 *   바이낸스 공개데이터라 키 불필요. 읽기전용(주문 없음).
 * 실행: npx tsx scripts/verify-chart-search-smoke.ts
 */
const { startDashboard } = await import("../src/dashboard/server.js");
const { url, port } = await startDashboard(0); // 0=에페메랄 포트
const token = new URL(url).searchParams.get("token") || "";
const base = `http://127.0.0.1:${port}`;
const q = `token=${encodeURIComponent(token)}`;
const j = async (path: string) => (await fetch(`${base}${path}${path.includes("?") ? "&" : "?"}${q}`)).json();
let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { if (c) { pass++; console.log(`  ✅ ${m}`); } else { fail++; console.log(`  ❌ ${m}`); } };

console.log(`── 차트 검색 + 임의 종목 차트 스모크 (port ${port}) ──`);
try {
  // 1) 검색(바이낸스) — BTC 입력 → BTCUSDT 포함
  const s = await j(`/api/search?broker=binance&q=BTC`);
  ok(s.ok && Array.isArray(s.symbols) && s.symbols.includes("BTCUSDT"), `검색 BTC → ${(s.symbols || []).slice(0, 6).join(", ")}`);

  // 2) 빈 검색 → USDT 마켓 기본 목록
  const s0 = await j(`/api/search?broker=binance&q=`);
  ok(s0.ok && (s0.symbols || []).length > 0 && (s0.symbols || []).every((x: string) => /USDT$/.test(x)), `빈 검색 → USDT ${s0.symbols?.length}종목`);

  // 3) 임의 종목 차트(합성 ID sym:binance:ETHUSDT)
  const c = await j(`/api/candles?bot=${encodeURIComponent("sym:binance:ETHUSDT")}`);
  ok(c.ok && Array.isArray(c.bars) && c.bars.length > 0 && c.symbol === "ETHUSDT" && c.ccy === "USD", `임의종목 차트 ETHUSDT: ${c.bars?.length}봉, ccy=${c.ccy}, 전략오버레이=${(c.overlays || []).length}(0이어야 정상)`);

  // 4) 임의 종목 + 토글 지표(rsi,bollinger) — 봇 없이도 지표 계산
  const ci = await j(`/api/candles?bot=${encodeURIComponent("sym:binance:BTCUSDT")}&ind=rsi,bollinger`);
  ok(ci.ok && ((ci.oscGroups || []).length > 0 || (ci.overlays || []).length > 0), `임의종목 토글지표: overlays=${(ci.overlays || []).length} osc=${(ci.oscGroups || []).length}`);

  // 5) 잘못된 종목 → 정직한 에러
  const cb = await j(`/api/candles?bot=${encodeURIComponent("sym:binance:NOTAREALCOIN")}`);
  ok(cb.ok === false && !!cb.error, `없는 종목 → 에러 표기: ${cb.error}`);

  // 6) KR 검색 → 심볼마스터 없음 안내(종목코드 직접입력)
  const k = await j(`/api/search?broker=kiwoom&q=005930`);
  ok(k.ok && Array.isArray(k.symbols) && typeof k.note === "string", `KR 검색 note: ${k.note}`);
} catch (e) {
  fail++; console.log("🔴 예외:", e instanceof Error ? e.message : String(e));
}

console.log(`\n${fail === 0 ? "🟢 PASS" : "🔴 FAIL"} — 검색/임의종목차트 스모크: ${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
