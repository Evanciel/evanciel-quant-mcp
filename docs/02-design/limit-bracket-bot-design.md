# Limit Bracket Bot (지속형 지정가 봇) — 설계

> 출처: ultracode 멀티에이전트 설계(9에이전트) + 적대 검증(3렌즈 25이슈, HIGH 12). 2026-06-15.
> 목적: 사용자가 종목·매수가·수량·(선택)매도가를 한 번 설정하면, 봇이 **장 열릴 때마다 미체결 지정가를 재주문**하고
> 체결되면 자동으로 매도 지정가를 걸어 매도 체결 시 자동 종료. **mock/testnet only, 메인넷 OFF 불변.**

## 1. 아키텍처 결정

- **새 root_node 타입 `"limit_bracket"`** (StrategyNode 트리에 미포함, scanner와 동급 봇 최상위 전용).
  - 이유: 가격기반 주문관리지 지표전략 아님. 인디케이터 엔진(runCompositeBacktest) 전혀 안 탐.
- **P1-5 pendingEntry 재사용 안 함**: P1-5는 Binance getOrderByClientId 의존(키움 불가) + 일회성 신호→타임아웃 시장가 폴백. 본 봇은 폴백 없는 순수 resting + 풀 라이프사이클.
- **데이터 모델**: `composite_strategies.root_node`(임의 JSON) + `bots.position_state`(JSON) 재사용 → **마이그레이션 0**.

```ts
// src/core/types/strategy.ts
export interface LimitBracketNode {
  id: string; type: "limit_bracket"; name: string;
  symbol: string;      // bot.symbol과 일치
  buyPrice: number;    // 매수 지정가(>0). 키움=roundToKrxTick 정렬됨.
  qty: number;         // 목표 매수 수량(>0). 키움=정수.
  sellPrice?: number;  // 선택 매도 지정가(>0, >buyPrice 권장). 없으면 매수전용.
}
export type BotRootNode = StrategyNode | ScannerNode | LimitBracketNode;
```

```ts
// src/runner/runner.ts — bots.position_state 에 저장 (PaperPosition 호환 공통필드 포함!)
interface LimitBracketState {
  phase: "awaiting_buy" | "buy_resting" | "bought" | "sell_resting" | "done";
  // ── 비상청산/포트폴리오캡 호환 공통필드 (CRIT safety#2) ──
  status: "open" | "closed";   // 보유중이면 'open' → emergencyStopAll/exposuresOf가 인식
  qty: number;                 // 현 봇 귀속 보유분(=filledQty - sold). emergencyStopAll이 청산할 수량.
  entryAvg?: number; live?: boolean;
  // ── 매수/매도 추적 ──
  entryOrderId?: string;       // 거래소 주문번호(키움 ord_no / Binance orderId). 절대 덮어쓰기 금지.
  entryCid?: string;           // Binance clientOrderId(멱등 보조). 키움 미사용.
  exitOrderId?: string; exitCid?: string;
  baselineQty: number;         // 봇 시작 시점 계좌 보유(체결=heldNow-baseline, CRIT kr#1)
  filledQty: number;           // 누적 매수 체결분(cntr_qty 기준, getPositions 아님)
  soldQty: number;             // 누적 매도 체결분
  lastKnownCntrQty?: number;   // 주문 소멸 직전 마지막 cntr_qty(부분체결 확정)
  // ── 멱등/디바운스/생존 ──
  sessionKey?: string;         // 마지막 주문 낸 세션(KR=KST날짜, 닫힌봉 기준). 벽시계 금지(CRIT safety#5)
  reorderCountToday?: number;  // 세션당 재주문 횟수(환경무관 캡, CRIT safety#3)
  reorderSessionKey?: string;  // reorderCountToday의 기준 세션
  fillMisses: number;          // 체결/만료 N틱 디바운스 카운터(RECON_CLEAR_MISSES=3 패턴)
  doneMisses: number;          // done 전이 N틱 디바운스
  bootGraceUsed?: boolean;     // 재시작 첫 틱 관측-only 그레이스(CRIT safety#6)
  openedAt: string;
}
```

## 2. 라이프사이클 (phase 전이)

```
awaiting_buy → buy_resting → bought → sell_resting → done(자동 stop)
                    ↑___재주문___|          ↑___재주문___|
```
- **awaiting_buy**: 첫 틱 시드(baselineQty=getPositions 캡처). isMarketOpen이면 buy_resting로 전이하며 매수.
- **buy_resting**: 장중 미체결이면 재주문(쿨다운·세션캡 종속), 장마감엔 모니터만. 체결 감지되면 bought.
- **bought**: sellPrice 있으면 sell_resting로(매도 주문), 없으면 done.
- **sell_resting**: buy_resting 대칭. 매도 체결되면 done.
- **done**: 잔존 반대편 주문 취소 → setBotStatus('stopped') → runner.stop() (상태저장 후 마지막).

## 3. 적대 검증 픽스 — 구현 불변식 (반드시 코드로 강제)

### 동시성 (races 렌즈)
- **[HIGH] R-1 per-bot 재진입 락**: `Runner._ticking:Set<string>`. `run()`에서 `if(_ticking.has(id))return; _ticking.add(id); tick(id).finally(()=>_ticking.delete(id))`. **모든 봇 타입에 적용(일반 수정)**. ← 최우선, 이거 없이 머지 금지. R-2(lost-update)/R-3(KR cid부재)/R-5(done레이스)/R-8(페이퍼레이스) 동시 해소.
- **[HIGH] R-2 entryOrderId 덮어쓰기 금지**: 기존 entryOrderId 있으면 새 주문 전 그 주문부터 조회. 락이 read-modify-write 원자화.

### 체결 감지 (kr 렌즈 — 가장 위험)
- **[HIGH] K-1 baseline-delta**: filledQty를 getPositions **절대값으로 쓰지 말 것**. 시작 시 baselineQty 캡처 → 체결분 = max(0, heldNow - baseline). 1차 근거는 **자기 주문 cntr_qty**(귀속 명확), getPositions는 교차검증만. (기존 보유분으로 유령체결→오버셀 차단)
- **[HIGH] K-2/R-4 '주문 소멸 ≠ 체결'**: (소멸 AND 보유증가>0)=체결 / (소멸 AND 증가0 AND N틱)=미체결소멸. **소멸 단독 판정 절대 금지.** 만료는 **세션경계(isMarketOpen false→true)에서만** 인정(장중 소멸≠만료, day-order는 장중 자가만료 안 함).
- **[HIGH] K-3 findRestingOrder 틱정렬 매칭**: 가격매칭은 raw가 아니라 `roundToKrxTick(buyPrice)` 기준 **정확히 1틱 이내**. entryOrderId(ord_no) 1차. 같은 종목·side 미체결이 2건 이상이면 **ambiguous-hold(fail-closed)** — 오입양 금지(수동주문/타봇 주문).
- **[MED] R-6 부분체결 브로커 분기**: 키움=getOpenOrders.executedQty(cntr_qty), Binance=getOrderByClientId.executedQty. (Binance getOpenOrders는 executedQty 미매핑 → binance.ts에 추가하거나 cid 경로 사용)
- **N틱 디바운스**: bought·done 전이는 `fillMisses/doneMisses >= 3` 연속 동일 관측 후에만(키움 getPositions 지연 오판 방지, RECON_CLEAR_MISSES 패턴 이식).

### 주문 경로·안전 (safety 렌즈)
- **[HIGH] S-4 fillOrder 재사용(+allowKrLimit 플래그)**: placeBracketOrder 신설 금지. fillOrder의 9겹 안전망(채널고정·실잔고사이징·normalizeQuantity·checkLimits·cid·cid입양·invalidateReconCache·rejected처리·미확인동결)을 그대로 통과. line~99 KR-limit 거절만 `opts.allowKrLimit`로 조건부 우회. pending=resting(절대 bought 아님).
- **[HIGH] S-1 stopBot 잔존주문 취소**: stop 시 entryOrderId/exitOrderId(또는 getOpenOrders 재발견)로 cancelOrder. 실패는 삼키지 말고 error 로그+감사+사용자 경고. done에서도 잔존 반대편 주문 취소. (Binance GTC는 봇 죽어도 영구 resting → 나체 노출 차단)
- **[HIGH] S-2 비상청산/포트폴리오 호환**: LimitBracketState에 status:'open'/qty/live 공통필드 → emergencyStopAll(runner.ts~1141)·exposuresOf가 자동 인식. E2E로 'HALT→청산+주문취소' 증명.
- **[HIGH] S-3 환경무관 한도**: 하드리밋(checkLimits)은 메인넷 전용(testnet 무력, 커밋 94b3d26). limit_bracket은 testnet only라 무방비 → validateLimitBracketNode에서 **절대 노셔널 상한**(buyPrice×qty) + **세션당 재주문 캡(≤기본 8회/세션)** + 연속 조회실패 시 재주문 동결.
- **[HIGH] S-5 멱등키 닫힌봉/세션 기준**: sessionKey=KST 세션 날짜(벽시계 Date.now() 금지). 주문 직후 **쿨다운**(N틱/T초)으로 getOpenOrders 인덱싱 지연 흡수. trades.idempotency_key=`${bot.id}:${entryOrderId}:fill:${cumFilledQty}`(부분체결 누적분마다 유일, 재관측엔 동일).
- **[HIGH] S-6 재시작 그레이스**: resume 첫 틱은 관측-only(재주문 금지) → 거래소 진실 수렴 시간. bootSeeded 패턴 차용.
- **[MED] 거래소 day-order 유효기간 명시**: 키움 placeOrder가 유효기간 미지정→거래소 기본 의존. '만료→재주문' 전제를 계약으로(가능하면 명시), 안 되면 세션캡이 안전망.
- **[MED] KR 청산공백 정직 고지**: KR은 거래소 상주 SL 없음 → 매도 지정가가 유일 청산. 봇 다운+day만료 시 손절 공백(P0-3 동일 한계) 문서·로그 고지.

### 정합성
- **[MED] backtest 비대상 loud reject**: validateBotRoot에 limit_bracket 분기(없으면 save 실패) + handlers.backtest()에서 limit_bracket 명시 거부('주문관리 봇=백테 비대상, 엔진 대응물 없음'). 조용한 빈결과 금지.
- **페이퍼 체결 시뮬**: 닫힌 봉 low≤buyPrice 교차 시 limit 체결 가정(resolveEntryFill 백테 모델과 일치) + idempotency_key. getPrice 단발 폴링 금지(레이스).
- **KR 라이브 게이트 패리티**: scanner가 같은 약점(getOrderByClientId 부재)으로 라이브 거절됨. limit_bracket은 2소스 교차+N틱 디바운스가 배선된 후에만 KR 라이브 허용(그 전 페이퍼만). 현 단계: testnet/mock에서 검증.

## 4. UI (사용자 요구 = 대시보드에서 생성)

설계 원안은 "MCP 전용"이었으나 **사용자 요구는 대시보드에서 검색→지정가 봇 생성**. → 대시보드에 추가:
- 주문 모달에 "지정가 봇으로" 옵션(매수가·수량·매도가 입력) → 신규 `POST /api/bot/limit` → saveComposite(LimitBracketNode)+createBot+startBot.
- 안전: 기존 /api/order 안전경로와 동일 원칙(서버가 검증, mock/testnet 게이트). 메인넷 생성은 별도 차단.

## 5. 변경 파일

1. `src/core/types/strategy.ts` — LimitBracketNode + BotRootNode 유니온
2. `src/core/validation/composite-node.ts` — validateLimitBracketNode + validateBotRoot 분기 + 절대 노셔널/수량 상한
3. `src/util/market-hours.ts` (신규) — isMarketOpen(broker, now) (KR 평일 09:00~15:18 연속매매 / Binance 24/7)
4. `src/runner/runner.ts` — ① **per-bot 재진입 락(run())** ② tickBot 분기 ③ tickLimitBracket() ④ fillOrder opts.allowKrLimit ⑤ 체결감지 순수헬퍼(detectBuyFill/detectSellFill) ⑥ findRestingOrder ⑦ getOpenOrders/getPositions TTL캐시 ⑧ emergencyStopAll/exposuresOf limit_bracket 인식(또는 공통필드로 자동)
5. `src/mcp-server/bot-handlers.ts` — startBot 중복가동 차단(broker+symbol, 타입무관) + stopBot 잔존주문 취소 + create note
6. `src/mcp-server/handlers.ts` — backtest() limit_bracket loud reject
7. `src/dashboard/server.ts` — "지정가 봇" 생성 UI + POST /api/bot/limit
8. `src/brokers/binance.ts` — getOpenOrders executedQty 매핑 추가(부분체결, R-6)
9. `test/limit-bracket-machine.test.ts`, `test/market-hours.test.ts` (신규)
10. `SETUP-LIVE.md` — 사용법 + KR 청산공백 고지

## 6. 구현 순서 (증분, 각 단계 tsc+test)

(a) per-bot 락 [최우선, 독립] → (b) market-hours+test → (c) 타입+검증+backtest reject → (d) fillOrder allowKrLimit → (e) tickLimitBracket+체결감지헬퍼+상태머신 → (f) stopBot취소+비상청산호환 → (g) 대시보드 UI+엔드포인트 → (h) machine 테스트 → (i) 2차 적대 검증 워크플로우 → 픽스.
