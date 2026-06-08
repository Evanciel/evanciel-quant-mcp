/**
 * setup/cli.ts — `npx quant-mcp setup` 대화형 자격증명 마법사. 키 입력은 화면 마스킹(*).
 * 저장은 credentials.upsertCredentials(chmod 600). 채팅/네트워크/브라우저 안 거침.
 */
import { createInterface } from "node:readline";
import { BROKER_FIELDS, upsertCredentials, credentialStatus, credentialsPath, mask, loadCredentialsFile, type BrokerKey } from "./credentials.js";

export async function runSetup(): Promise<void> {
  loadCredentialsFile(); // 기존 값 표시용
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const rli = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  const normalWrite = rli._writeToOutput?.bind(rli) ?? ((s: string) => process.stdout.write(s));

  const ask = (q: string, hidden = false): Promise<string> =>
    new Promise((resolve) => {
      if (hidden) {
        process.stdout.write(q);
        rli._writeToOutput = (s: string) => { for (const _ of s.replace(/[\r\n]/g, "")) rli.output.write("*"); };
        rl.question("", (a) => { rli._writeToOutput = normalWrite; process.stdout.write("\n"); resolve(a); });
      } else {
        rl.question(q, resolve);
      }
    });

  console.log("\n🔐 quant-mcp 자격증명 설정");
  console.log(`저장 위치: ${credentialsPath()} (chmod 600, gitignore). 화면/채팅/네트워크에 키 노출 안 함.\n`);

  const st = credentialStatus();
  console.log("현재 설정:");
  for (const b of Object.keys(BROKER_FIELDS) as BrokerKey[]) console.log(`  ${b}: ${st[b].configured ? "✓ 설정됨" : "✗ 미설정"}`);
  console.log("");

  const broker = ((await ask("설정할 브로커 (binance/kis/kiwoom) [binance]: ")).trim() || "binance") as BrokerKey;
  if (!BROKER_FIELDS[broker]) { console.log(`알 수 없는 브로커: ${broker}`); rl.close(); return; }

  const updates: Record<string, string> = {};
  for (const f of BROKER_FIELDS[broker]) {
    const cur = (process.env[f.key] ?? "").trim();
    const hint = cur ? ` [현재 ${f.secret ? mask(cur) : cur}, Enter=유지]` : f.optional ? " [선택, Enter=건너뜀]" : "";
    const v = (await ask(`  ${f.label}${hint}: `, f.secret)).trim();
    if (v) updates[f.key] = v;
  }

  const { written, path } = upsertCredentials(updates);
  console.log(`\n✅ 저장 완료 (${written.length}개 항목): ${path}`);
  const after = credentialStatus()[broker];
  console.log(`   ${broker}: ${after.configured ? "✓ 설정됨" : "✗ 미완료(필수 키 누락)"}`);
  for (const f of BROKER_FIELDS[broker]) console.log(`     ${f.key} = ${after.fields[f.key]}`);
  console.log("\n⚠️ testnet/mock은 즉시 거래(가짜돈). 메인넷(live)은 추가로 LIVE_TRADING_ENABLED=true 필요(SETUP-LIVE.md).");
  console.log("   MCP 서버 재시작 시 이 파일을 자동 로드합니다.\n");
  rl.close();
}
