/** check-bot-logs.ts — 레짐정지 봇 최근 로그·status·position 확인(읽기전용). 실행: npx tsx scripts/check-bot-logs.ts */
const store = await import("../src/store/db.js");
for (const b of store.listBots()) {
  if (!/레짐정지/.test(b.name)) continue;
  const ps = b.position_state as { status?: string; qty?: number; entryAvg?: number } | null;
  const pos = ps?.status === "open" ? `보유 ${ps.qty} @ ${ps.entryAvg}` : "무포지션(관망)";
  console.log(`\n■ ${b.name} [${b.id.slice(0, 8)}] ${b.symbol} — status=${b.status} mode=${b.mode} → ${pos}`);
  console.log(`  last_executed_at=${b.last_executed_at ?? "(없음)"}`);
  for (const l of store.recentLogs(b.id, 6)) console.log(`   · [${l.action}] ${(l.detail || "").slice(0, 90)}`);
}
