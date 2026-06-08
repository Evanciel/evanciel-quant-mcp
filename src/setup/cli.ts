/**
 * setup/cli.ts — `npx quant-mcp setup` 대화형 자격증명 마법사. 라이브 친화: 키만 넣으면 바로 매매되게.
 * 키 입력은 화면 마스킹(*). 저장=credentials.upsertCredentials(chmod 600). 채팅/네트워크/브라우저 안 거침.
 * 실거래(live) 선택 시: 키 + 출금권한 확인 → 마스터 스위치 자동 ON + 안전 기본값 → 바로 실매매 준비.
 */
import { createInterface } from "node:readline";
import {
  BROKER_FIELDS, upsertCredentials, credentialStatus, credentialsPath, mask, loadCredentialsFile,
  enableLive, liveSettingsStatus, LIVE_DEFAULTS, type BrokerKey,
} from "./credentials.js";

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
  const yes = (s: string) => /^(y|yes|네|예|응|ㅇ|true|1)$/i.test(s.trim());

  console.log("\n🔐 quant-mcp 자격증명 설정");
  console.log(`저장 위치: ${credentialsPath()} (chmod 600, gitignore). 화면/채팅/네트워크에 키 노출 안 함.\n`);

  const st = credentialStatus();
  console.log("현재 설정:");
  for (const b of Object.keys(BROKER_FIELDS) as BrokerKey[]) console.log(`  ${b}: ${st[b].configured ? "✓ 설정됨" : "✗ 미설정"}`);
  const ls0 = liveSettingsStatus();
  console.log(`  실거래 마스터: ${ls0.masterOn ? "🟢 ON" : "⚪ OFF(페이퍼)"}\n`);

  const broker = ((await ask("설정할 브로커 (binance/kis/kiwoom) [binance]: ")).trim() || "binance") as BrokerKey;
  if (!BROKER_FIELDS[broker]) { console.log(`알 수 없는 브로커: ${broker}`); rl.close(); return; }

  // ── 환경 선택(친화): 연습(가짜돈) vs 실거래(실돈). binance만 testnet, kis/kiwoom은 mock. ──
  const envField = BROKER_FIELDS[broker].find((f) => /ENV$/.test(f.key));
  const practice = broker === "binance" ? "testnet" : "mock";
  let chosenEnv = practice;
  if (envField) {
    console.log("\n무엇을 할까요?");
    console.log(`  1) 연습 (${practice}, 가짜돈) — 안전하게 전략 테스트 [기본]`);
    console.log("  2) 실거래 (live, 실돈) — 키 넣으면 바로 매매");
    const sel = (await ask("선택 [1]: ")).trim();
    chosenEnv = sel === "2" || /live|실거래/i.test(sel) ? "live" : practice;
  }

  // ── 키 입력(ENV 필드는 위 선택으로 대체) ──
  const updates: Record<string, string> = {};
  if (envField) updates[envField.key] = chosenEnv;
  for (const f of BROKER_FIELDS[broker]) {
    if (/ENV$/.test(f.key)) continue; // 환경은 위에서 정함
    const cur = (process.env[f.key] ?? "").trim();
    const hint = cur ? ` [현재 ${f.secret ? mask(cur) : cur}, Enter=유지]` : f.optional ? " [선택, Enter=건너뜀]" : "";
    const v = (await ask(`  ${f.label}${hint}: `, f.secret)).trim();
    if (v) updates[f.key] = v;
  }
  const { written, path } = upsertCredentials(updates);
  console.log(`\n✅ 키 저장 완료 (${written.length}개): ${path}`);

  // ── 실거래면 원스톱 활성화(마스터 ON + 안전 기본값) ──
  if (chosenEnv === "live") {
    console.log("\n⚠️ 실거래(실돈)를 켭니다. 안전 확인:");
    const wd = await ask("  거래소에서 이 키의 [출금 권한]을 껐나요? (출금 OFF, 거래 권한만) [y/N]: ");
    if (!yes(wd)) {
      console.log("  → 출금 권한을 먼저 끄세요(키 유출 시 자금 인출 위험). 실거래는 켜지 않고 키만 저장했습니다.");
      console.log("     출금 끈 뒤 다시 'npx quant-mcp setup' 실행하면 실거래가 켜집니다.");
      rl.close(); return;
    }
    const capIn = (await ask(`  주문당 최대 금액(USDT) [${LIVE_DEFAULTS.LIVE_MAX_NOTIONAL}]: `)).trim();
    const allowIn = (await ask("  거래 허용 종목(쉼표, 비우면 전체 허용) [예: BTCUSDT,ETHUSDT]: ")).trim();
    const r = enableLive({ maxNotional: capIn || undefined, allowlist: allowIn || undefined });
    console.log(`  🟢 실거래 ON — 마스터 스위치 + 안전 기본값 적용(${r.written.join(", ")}).`);
    const ls = liveSettingsStatus();
    console.log(`     환경=${ls.env} · 주문당 최대=${ls.maxNotional} USDT · 허용종목=${ls.allowlist} · 일일손실서킷=${ls.dailyLossLimit} USDT`);
    console.log("\n🚀 준비 끝! 이제 자비스(에이전트)에게 \"실거래 봇 돌려줘\"라고 하면 바로 실매매가 나갑니다.");
    console.log("   사전점검: npx tsx scripts/verify-mainnet-readiness.ts (주문 0건, 출금권한·리밋 확인)");
    console.log("   🛑 긴급 정지: 'npx quant-mcp setup'에서 실거래 끄기, 또는 LIVE_TRADING_ENABLED=false.");
  } else {
    console.log(`\n${chosenEnv} 연습 모드로 저장(가짜돈). 실매매하려면 다시 실행해 '실거래(live)'를 고르세요.`);
    // 사용자가 실거래를 명시적으로 안 골랐는데 binance를 다시 연습으로 바꾼 경우, 마스터가 켜져 있으면 끄지 않음(키는 그대로). 안내만.
  }

  console.log("\nMCP 서버 재시작 시 이 설정을 자동 로드합니다.\n");
  rl.close();
}
