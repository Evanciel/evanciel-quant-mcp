/**
 * inspect-state.ts — 데몬 가동 전 상태 점검(읽기전용). 봇 목록·status·position + 자격증명 설정여부(마스킹) + 데이터 경로.
 *   .env.local(gitignored) 키도 로드해 "데몬이 보게 될" 자격증명 상태를 그대로 반영(값은 마스킹만, 노출 0).
 * 실행: npx tsx scripts/inspect-state.ts
 */
import { readFileSync, existsSync } from "node:fs";
if (existsSync(".env.local")) { for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); } }
const { loadCredentialsFile, credentialStatus, liveSettingsStatus, dataDir, credentialsPath } = await import("../src/setup/credentials.js");
const store = await import("../src/store/db.js");
const n = loadCredentialsFile();
console.log(`데이터 경로: ${dataDir()}`);
console.log(`자격증명 파일: ${credentialsPath()} (credentials.env에서 ${n}개 로드)`);
const cs = credentialStatus();
console.log(`자격증명 설정여부(마스킹): binance=${cs.binance.configured} env=${cs.binance.fields.BINANCE_ENV} key=${cs.binance.fields.BINANCE_API_KEY}`);
const ls = liveSettingsStatus();
console.log(`라이브 마스터스위치: masterOn=${ls.masterOn} env=${ls.env} (메인넷은 masterOn=true 일 때만 — 현재 testnet 안전)`);
console.log(`\n── 봇 목록 ──`);
for (const b of store.listBots()) {
  const ps = b.position_state as { status?: string; qty?: number } | null;
  const pos = ps?.status === "open" ? `보유 ${ps.qty}` : "무포지션";
  console.log(`${b.status.padEnd(8)} | ${b.mode.padEnd(5)} | ${b.broker.padEnd(8)} | ${b.symbol.padEnd(9)} | ${pos} | ${b.name}  [${b.id.slice(0, 8)}]`);
}
