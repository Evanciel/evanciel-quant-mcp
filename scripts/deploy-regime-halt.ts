/**
 * deploy-regime-halt.ts — 레짐 정지 봇 testnet 배포 + 첫 틱 검증.
 *   트리: condition(regime∈[trend_up]) → 보유(buy), else → 관망(sell). 일봉. mode=live(liveGate=testnet only).
 *   현재 하락장이면 봇이 자동 관망(매수 안 함) = 리스크 통제 데모. .env.local(gitignored)에서 키 로드.
 * 실행: npx tsx scripts/deploy-regime-halt.ts
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
const { saveComposite, createBot, startBot } = await import("../src/mcp-server/bot-handlers.js");
const { runner } = await import("../src/runner/runner.js");
const store = await import("../src/store/db.js");
const { liveGate } = await import("../src/brokers/safety.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const now = new Date().toISOString();

const g = liveGate("binance", "spot");
console.log(`Binance 게이트: allowed=${g.allowed} env=${g.env} (${g.reason || ""})`);
const rule = (action: string) => ({ id: action, action, conditions: [{ id: "c", indicator: "rsi", params: { period: 14 }, operator: "lt", value: 101 }], quantityPercent: 100 });
const leaf = (name: string, action: string, symbol: string) => ({ id: name, type: "leaf", name, strategy: { id: "s", userId: "u", name, description: "", symbol, rules: [rule(action)], isActive: true, createdAt: now, updatedAt: now } });
const tree = (symbol: string) => ({ id: "r", type: "condition", name: "레짐정지", condition: { type: "regime", in: ["trend_up"] }, thenNode: leaf("보유(상승레짐)", "buy", symbol), elseNode: leaf("관망(비상승)", "sell", symbol) });

for (const symbol of ["BTCUSDT", "ETHUSDT"]) {
  const comp = saveComposite({ name: `${symbol} 레짐정지`, tree: tree(symbol), symbol, market: "spot", stopLossPercent: 12 }) as { ok?: boolean; compositeStrategyId?: string; error?: string };
  if (!comp.ok || !comp.compositeStrategyId) { console.log(`${symbol} 전략저장 실패: ${comp.error}`); continue; }
  const bot = createBot({ name: `${symbol} 레짐정지봇`, compositeStrategyId: comp.compositeStrategyId, symbol, mode: "live", broker: "binance", intervalSeconds: 86400 }) as { ok?: boolean; botId?: string; error?: string };
  if (!bot.ok || !bot.botId) { console.log(`${symbol} 봇생성 실패: ${bot.error}`); continue; }
  startBot({ botId: bot.botId });
  await sleep(9000); // 첫 틱(일봉 페치+레짐판정+결정) 대기
  const b = store.getBot(bot.botId);
  const logs = store.recentLogs(bot.botId, 4).map((l) => `${l.action}:${(l.detail || "").slice(0, 70)}`);
  const ps = b?.position_state ? "보유" : "무포지션(관망)";
  console.log(`\n[${symbol}] bot=${bot.botId} status=${b?.status} → ${ps}`);
  for (const l of logs) console.log(`   · ${l}`);
  runner().stop(bot.botId); // 검증 후 이 프로세스 타이머 정리(봇 row는 store에 남음 → 데몬이 일봉 주기 운용)
}
console.log(`\n✅ 배포 완료(store 영속). 현재 레짐이 trend_up이 아니면 봇은 '관망'(매수 안 함)=리스크 통제 작동. 데몬 가동 시 일봉마다 자동 평가. 메인넷 OFF.`);
