/**
 * go-daemon.ts — 레짐정지 봇 2개를 24/7 데몬으로 가동(로컬 백그라운드 런처).
 *   ① .env.local(gitignored)에서 testnet 키를 process.env로 로드(값은 코드가 처리 — 노출 0).
 *   ② "레짐정지" 라이브 봇을 running으로 복귀(deploy 스크립트가 검증 후 stop=stopped로 둔 것 → resumeAll 대상화).
 *   ③ daemon.ts 기동(import 시 main 실행 → resumeAll + 대시보드 + /healthz + graceful shutdown).
 * 실행(백그라운드): npx tsx scripts/go-daemon.ts
 * 메인넷 OFF 불변(liveGate가 testnet/mock만 통과 — LIVE_TRADING_ENABLED 미설정).
 */
import { readFileSync, existsSync } from "node:fs";
if (existsSync(".env.local")) {
  for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}
const store = await import("../src/store/db.js");
let armed = 0;
for (const b of store.listBots()) {
  if (b.mode === "live" && /레짐정지/.test(b.name) && b.status !== "running") {
    store.setBotStatus(b.id, "running");
    store.insertLog(b.id, "info", "go-daemon: 24/7 데몬 가동을 위해 running 복귀");
    armed++;
    console.log(`[go-daemon] running 복귀: ${b.name} [${b.id.slice(0, 8)}] ${b.symbol}`);
  }
}
console.log(`[go-daemon] ${armed}개 봇 running 복귀 → 데몬 기동(resumeAll + 대시보드)…`);
await import("../src/daemon.ts"); // main()이 import 시 실행 — 프로세스 상주
