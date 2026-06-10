/**
 * index.ts — quant-mcp 서버 엔트리(stdio transport). 8개 분석/백테스트 툴을 등록.
 * 모든 데이터=Binance 공개 REST(키 불필요), 모든 계산=core 순수함수(backtest≡live).
 * 정직 포지셔닝: 각 툴은 리스크 필터 + 표현력 도구이지 알파 생성기가 아니다.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as H from "./handlers.js";
import * as B from "./bot-handlers.js";
import * as L from "./live-handlers.js";
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
    description: `전략을 Binance 공개 데이터로 백테스트. 전체 통계 + 70/30 walk-forward OOS + PSR(운으로 설명될 확률). oosRobust=과적합 아님 신호. indicator·regime 조건 모두 timeframe 지정 가능(상위TF 평가, 예: 1h 추세 레짐 게이트 + 5m 진입). ${DISCLAIMER}`,
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

  server.registerTool("list_events", {
    title: "이벤트 캘린더 조회(FOMC 등)",
    description: `내장 일정 이벤트 캘린더(FOMC 등) 날짜 조회. event 조건(calendar 또는 인라인 times)으로 "FOMC 2시간 전 청산"·"실적 직후 변동성 매매" 같은 전략 구성. 일정 이벤트는 날짜가 사실이라 백테스트 가능. ${DISCLAIMER}`,
    inputSchema: S.listEventsShape, annotations: { readOnlyHint: true },
  }, guard((a) => H.listEvents(a as Parameters<typeof H.listEvents>[0])));

  server.registerTool("allocate_portfolio", {
    title: "포트폴리오 자본 배분 제안",
    description: `여러 심볼에 자본을 어떻게 나눌지 제안(equal/inverse_vol=리스크패리티 대각근사/vol_target). 실시세 EWMA 변동성 기반. 자동 리밸런스 아닌 '제안'. ${DISCLAIMER}`,
    inputSchema: S.allocatePortfolioShape, annotations: { readOnlyHint: true },
  }, guard((a) => H.allocatePortfolioTool(a as Parameters<typeof H.allocatePortfolioTool>[0])));

  server.registerTool("scan_universe", {
    title: "유니버스 스크리닝 + 크로스섹셔널 랭킹",
    description: `여러 종목을 메트릭(gapPct/roc/relVolume/rangePct)으로 평가→랭킹→상위 N 반환. "아침 급등주 스크리닝"의 읽기 도구. 스캐너 봇(save_strategy에 scanner 노드)으로 자동화 가능. ${DISCLAIMER}`,
    inputSchema: S.scanUniverseShape, annotations: { readOnlyHint: true },
  }, guard((a) => H.scanUniverse(a as Parameters<typeof H.scanUniverse>[0])));

  // ── v2: 봇/전략/대시보드 (로컬 스토어 + 페이퍼 러너) ──
  server.registerTool("save_strategy", {
    title: "전략(복합전략) 저장",
    description: `에이전트가 조립한 복합 전략 트리를 검증 후 로컬 스토어에 저장. 반환 id로 봇을 만든다. riskSizing(vol_target)으로 변동성 타게팅 사이징 가능(리스크 통제, 알파 아님 — 미설정 시 quantityPercent). ${DISCLAIMER}`,
    inputSchema: S.saveCompositeShape,
  }, guard((a) => B.saveComposite(a as Parameters<typeof B.saveComposite>[0])));

  server.registerTool("create_bot", {
    title: "로컬 봇 생성",
    description: `저장한 전략으로 로컬 봇 생성(기본 paper). 라이브 실행은 v2.5(브로커 키 + 2단계 확인토큰 + 하드게이트). ${DISCLAIMER}`,
    inputSchema: S.createBotShape,
  }, guard((a) => B.createBot(a as Parameters<typeof B.createBot>[0])));

  server.registerTool("list_bots", {
    title: "봇 목록", description: `로컬 봇 목록 + 상태. ${DISCLAIMER}`, inputSchema: S.listBotsShape,
  }, guard(() => B.listBots()));

  server.registerTool("get_bot_status", {
    title: "봇 상태", description: `봇 상태 + 포지션 + 최근 체결/로그. ${DISCLAIMER}`, inputSchema: S.botIdShape,
  }, guard((a) => B.getBotStatus(a as { botId: string })));

  server.registerTool("start_bot", {
    title: "봇 가동", description: `봇을 페이퍼로 가동(interval마다 평가, core 엔진 재사용=backtest≡live). ${DISCLAIMER}`, inputSchema: S.botIdShape,
  }, guard((a) => B.startBot(a as { botId: string })));

  server.registerTool("stop_bot", {
    title: "봇 중지", description: `봇 가동 중지. ${DISCLAIMER}`, inputSchema: S.botIdShape,
  }, guard((a) => B.stopBot(a as { botId: string })));

  server.registerTool("open_dashboard", {
    title: "실시간 HTML 대시보드 열기",
    description: `로컬(127.0.0.1) HTML 대시보드 기동 + URL 반환. 봇 포지션 + 실시간 미실현손익(Binance WS). 읽기전용·토큰보호. ${DISCLAIMER}`,
    inputSchema: S.openDashboardShape,
  }, guard((a) => B.openDashboard(a as { port?: number })));

  // ── v2.5: 라이브 거래(BYOK, 안전게이트). place_order=fail-closed 2단계토큰. ──
  server.registerTool("live_status", {
    title: "라이브 설정 상태",
    description: `어떤 브로커가 어떤 env(testnet/mock/live)로 설정됐는지 + 마스터스위치 + 하드리밋(키 노출 0). ${DISCLAIMER}`,
    inputSchema: S.liveStatusShape, annotations: { readOnlyHint: true },
  }, guard(() => L.liveStatus()));

  server.registerTool("get_positions", {
    title: "실포지션 조회(BYOK)",
    description: `거래소 키로 실제 포지션 조회. 키 없으면 안내. ${DISCLAIMER}`,
    inputSchema: S.brokerReadShape, annotations: { readOnlyHint: true },
  }, guard((a) => L.getPositions(a as Parameters<typeof L.getPositions>[0])));

  server.registerTool("get_balance", {
    title: "실잔고 조회(BYOK)",
    description: `거래소 키로 실제 잔고 조회. ${DISCLAIMER}`,
    inputSchema: S.brokerReadShape, annotations: { readOnlyHint: true },
  }, guard((a) => L.getBalance(a as Parameters<typeof L.getBalance>[0])));

  server.registerTool("place_order", {
    title: "실주문(BYOK, 2단계 확인)",
    description: `실제 주문. **fail-CLOSED 2단계**: 1차=프리뷰+확인토큰, 2차=동일인자+토큰이어야 실행. testnet/mock 키는 즉시, 메인넷은 LIVE_TRADING_ENABLED=true 필요. 서버측 하드리밋(노셔널캡/심볼allowlist/일일손실서킷) 적용. ${DISCLAIMER}`,
    inputSchema: S.placeOrderShape, annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
  }, guard((a) => L.placeOrder(a as Parameters<typeof L.placeOrder>[0])));

  server.registerTool("place_protective", {
    title: "보호주문 OCO 설정(BYOK, 2단계 확인)",
    description: `현물 롱 포지션에 익절+손절 OCO(한쪽 체결 시 다른쪽 자동취소) 상주주문. **fail-CLOSED 2단계**(무토큰=프리뷰+토큰, 동일인자+토큰=실행). 서버가 실보유수량·방향·노셔널(TP·SL 각각)을 전부 재검증. 봇 다운/봉 사이에도 거래소가 손절 지킴=리스크 통제 핵심. testnet/mock 즉시, 메인넷은 LIVE_TRADING_ENABLED=true. ${DISCLAIMER}`,
    inputSchema: S.placeProtectiveShape, annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: false },
  }, guard((a) => L.placeProtective(a as Parameters<typeof L.placeProtective>[0])));

  server.registerTool("get_protective", {
    title: "상주 보호주문 조회(BYOK)",
    description: `심볼의 상주 OCO 상태 + 실보유(매도가능 free) 조회. 세션 간 복원·중복등록 방지용. 읽기전용, 키 미노출. ${DISCLAIMER}`,
    inputSchema: S.getProtectiveShape, annotations: { readOnlyHint: true },
  }, guard((a) => L.getProtective(a as Parameters<typeof L.getProtective>[0])));

  server.registerTool("cancel_protective", {
    title: "보호주문 OCO 취소(BYOK)",
    description: `orderListId로 상주 OCO 취소(get_protective가 반환). liveGate 경유 + audit. 취소 후 재등록 가능. ${DISCLAIMER}`,
    inputSchema: S.cancelProtectiveShape, annotations: { destructiveHint: true, readOnlyHint: false, idempotentHint: true },
  }, guard((a) => L.cancelProtective(a as Parameters<typeof L.cancelProtective>[0])));

  return server;
}

async function main() {
  const { loadCredentialsFile } = await import("../setup/credentials.js");
  const n = loadCredentialsFile(); // ~/.quant-mcp/credentials.env → process.env (MCP 설정 env 우선)
  if (n > 0) process.stderr.write(`loaded ${n} credential(s) from credentials.env\n`);
  const server = buildServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  const { runner } = await import("../runner/runner.js");
  runner().resumeAll(); // 재기동 시 running 봇 재개
  const shutdown = () => { runner().shutdown(); process.exit(0); };
  process.on("SIGINT", shutdown); process.on("SIGTERM", shutdown);
  // stdio 서버는 stdout=프로토콜 채널 → 로그는 stderr로.
  process.stderr.write("quant-mcp server ready (stdio) — 25 tools (8 analysis + scan_universe + allocate_portfolio + list_events + 7 bot + 7 live). paper mode. risk filter, not alpha source.\n");
}

// 직접 실행 시에만 기동(테스트 import 시엔 buildServer만 사용).
const isMain = import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("index.ts") || process.argv[1]?.endsWith("index.js");
if (isMain) {
  // `npx quant-mcp setup` → 대화형 자격증명 마법사(서버 미기동, 키는 화면 마스킹).
  if (process.argv[2] === "setup") {
    import("../setup/cli.js")
      .then(({ runSetup }) => runSetup())
      .then(() => process.exit(0))
      .catch((e) => { process.stderr.write(`setup failed: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
  } else {
    main().catch((e) => { process.stderr.write(`fatal: ${e instanceof Error ? e.message : String(e)}\n`); process.exit(1); });
  }
}
