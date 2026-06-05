/**
 * index.ts — quant-mcp 서버 엔트리(stdio transport). 8개 분석/백테스트 툴을 등록.
 * 모든 데이터=Binance 공개 REST(키 불필요), 모든 계산=core 순수함수(backtest≡live).
 * 정직 포지셔닝: 각 툴은 리스크 필터 + 표현력 도구이지 알파 생성기가 아니다.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as H from "./handlers.js";
import * as S from "./schemas.js";

const DISCLAIMER = "주의: 리스크 필터 + 표현력 도구이지 알파 생성기가 아님(리테일 방향성 알파≈0). 기대수익을 보장하지 않음.";

const json = (v: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(v) }] });
// 핸들러 예외 → 도구 에러 결과(서버 죽지 않음).
const guard = <A>(fn: (a: A) => unknown | Promise<unknown>) => async (a: A) => {
  try { return json(await fn(a)); }
  catch (e) { return json({ ok: false, error: e instanceof Error ? e.message : String(e) }); }
};

export function buildServer(): McpServer {
  const server = new McpServer({ name: "quant-mcp", version: "0.1.0" });

  server.registerTool("validate_strategy", {
    title: "전략 트리 검증",
    description: `복합 전략 트리(leaf/composite/condition)를 재귀한도·weighted경계·time/between 등으로 검증. 다른 모든 툴의 상류 안전 게이트. ${DISCLAIMER}`,
    inputSchema: S.validateStrategyShape,
  }, guard((a) => H.validateStrategy(a as { tree: unknown })));

  server.registerTool("backtest", {
    title: "백테스트 + 워크포워드 OOS",
    description: `전략을 Binance 공개 데이터로 백테스트. 전체 통계 + 70/30 walk-forward OOS + PSR(운으로 설명될 확률). oosRobust=과적합 아님 신호. ${DISCLAIMER}`,
    inputSchema: S.backtestShape,
  }, guard((a) => H.backtest(a as Parameters<typeof H.backtest>[0])));

  server.registerTool("backtest_short", {
    title: "숏 백테스트",
    description: `숏 전략 백테스트(sell=숏진입, buy=커버). runShortBacktest 공용(롱과 동일 신호평가→backtest≡live). 펀딩/트레일링 리스크 반영. ${DISCLAIMER}`,
    inputSchema: S.backtestShortShape,
  }, guard((a) => H.backtestShort(a as Parameters<typeof H.backtestShort>[0])));

  server.registerTool("detect_regime", {
    title: "시장 레짐 감지",
    description: `ADX/Kaufman ER/ATR%로 추세·횡보·고변동 레짐 분류(50+ 봉 필요). 전략 게이팅·사이징 보조. ${DISCLAIMER}`,
    inputSchema: S.detectRegimeShape,
  }, guard((a) => H.detectRegime(a as Parameters<typeof H.detectRegime>[0])));

  server.registerTool("derivatives_signal", {
    title: "파생 신호(펀딩/OI/롱숏)",
    description: `Binance fapi 펀딩(연율화)/OI 4분면/롱숏 틸트/테이커 흐름. fapi 지역차단·레이트리밋 시 부분 degrade(null+note). ${DISCLAIMER}`,
    inputSchema: S.derivativesSignalShape,
  }, guard((a) => H.derivativesSignal(a as Parameters<typeof H.derivativesSignal>[0])));

  server.registerTool("suggest_position_size", {
    title: "포지션 사이징 제안",
    description: `EWMA 변동성타게팅/ATR/분수 Kelly로 포지션 크기 제안. 실시세 ATR(14)+실현변동성 계산. 리스크 통제 핵심. ${DISCLAIMER}`,
    inputSchema: S.suggestPositionSizeShape,
  }, guard((a) => H.suggestPositionSize(a as Parameters<typeof H.suggestPositionSize>[0])));

  server.registerTool("portfolio_risk", {
    title: "포트폴리오 리스크 평가",
    description: `caller가 제공한 포지션으로 heat/유효리스크/MDD 서킷브레이커/상관보정 계산(순수, 계정 불필요). ${DISCLAIMER}`,
    inputSchema: S.portfolioRiskShape,
  }, guard((a) => H.portfolioRisk(a as Parameters<typeof H.portfolioRisk>[0])));

  server.registerTool("strategy_factory", {
    title: "전략 팩토리(거짓발견 필터)",
    description: `대량 후보 → OOS + Deflated Sharpe(다중검정 보정)로 생존자 선별. 대부분 기각이 정상(알파 생성기 아님, 거짓발견 필터). ${DISCLAIMER}`,
    inputSchema: S.strategyFactoryShape,
  }, guard((a) => H.strategyFactory(a as Parameters<typeof H.strategyFactory>[0])));

  return server;
}

async function main() {
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 서버는 stdout=프로토콜 채널 → 로그는 stderr로.
  process.stderr.write("quant-mcp server ready (stdio) — 8 tools. risk filter, not alpha source.\n");
}

// 직접 실행 시에만 기동(테스트 import 시엔 buildServer만 사용).
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  main().catch((e) => { process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
}
