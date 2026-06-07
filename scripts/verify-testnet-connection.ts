/**
 * verify-testnet-connection.ts — testnet 키로 읽기전용 연결 검증(주문 없음). 잔고/포지션 조회.
 * 실행: npx tsx scripts/verify-testnet-connection.ts (.env.local 자동 로드)
 */
import { readFileSync } from "node:fs";
// .env.local 로드(import-time env 읽는 모듈 없음 → 런타임 getAdapter 전에 적용됨)
try {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
} catch { console.error(".env.local 없음"); process.exit(1); }

const { getAdapter } = await import("../src/brokers/index.js");
const { liveGate, loadCredentials, mask } = await import("../src/brokers/safety.js");

for (const market of ["spot", "futures"] as const) {
  console.log(`\n=== binance ${market} (testnet) ===`);
  const gate = liveGate("binance", market);
  const c = loadCredentials("binance", market);
  console.log("키:", mask(c?.apiKey), "| 게이트:", gate.allowed, `(${gate.env})`, "—", gate.reason);
  if (!gate.allowed) { console.log("→ 스킵(게이트 차단)"); continue; }
  const got = getAdapter("binance", market);
  if (!got) { console.log("→ 어댑터 없음"); continue; }
  try {
    const bal = await got.adapter.getBalance();
    console.log("✅ 잔고:", JSON.stringify(bal));
  } catch (e) { console.log("❌ 잔고 조회 실패:", e instanceof Error ? e.message : String(e)); }
  try {
    const pos = await got.adapter.getPositions();
    console.log("✅ 포지션:", pos.length, "개", pos.length ? JSON.stringify(pos.slice(0, 3)) : "");
  } catch (e) { console.log("❌ 포지션 조회 실패:", e instanceof Error ? e.message : String(e)); }
}
console.log("\n검증 완료(읽기전용, 주문 없음).");
