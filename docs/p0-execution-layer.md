# P0 실행/리스크 레이어 — 키 없이 준비한 것 + testnet 배선 계획

> 목적: "표현 가능 ≠ 실투자 가능"의 P0 실행 구멍을 막기 위한 코어를 **키 없이** 구축. 실제 거래소 머니패스
> E2E만 testnet 키 대기. 이 문서는 무엇이 준비됐고, 키 도착 시 어디에 어떻게 배선하는지의 명세.
> 생성: 2026-06-07

## 1. 키 없이 완성한 것 (빌드 + 테스트 완료)

### 코어 (순수함수, 100% 단위테스트)
- `src/core/execution/protective.ts`
  - `planProtectiveOrders(input)` — 포지션(롱/숏)+리스크(SL/TP/트레일링) → 거래소 상주 보호주문 목록. 트레일링은 고점/저점 기준 유효 손절 산출.
  - `reconcileProtective(desired, restingIds)` — 원하는 보호주문 vs 현재 걸린 것 → 취소/신규 차이(멱등, 트레일링 갱신 시 옛 것 취소+새 것).
  - `syncProtective(desired, restingIds, place, cancel)` — 어댑터 콜백 주입 오케스트레이션(부분성공 허용). **mock 어댑터로 테스트됨.**
- `src/core/execution/reconcile.ts`
  - `computePositionDrift(localQty, exchangeQty)` — 로컬 장부 vs 거래소 진실 → 발산 정량화 + 거래소채택 권고.
  - `sizeFromBalance(cash, price, pct, lot)` — 실잔고 기반 수량(정적 capital 대신) → 잔고초과 주문 방지.
  - `classifyFillStatus(order)` — 모호한 주문의 체결여부 판정(filled/open/not_placed/rejected/unknown).

### 어댑터 확장 (코드 — 거래소 호출만 키 대기)
- `OrderRequest.type` += `stop_market | stop_limit | take_profit_market`, `stopPrice`, `reduceOnly`.
- `binance.ts placeOrder` — 보호주문 타입 매핑(spot: STOP_LOSS/STOP_LOSS_LIMIT/TAKE_PROFIT, futures: STOP_MARKET/TAKE_PROFIT_MARKET) + stopPrice.
- 어댑터 포트엔 이미 `getBalance/getPositions/cancelOrder/getOrderByClientId` 존재.

### 데이터 모델 준비
- `PaperPosition`에 `protectiveIds?`(상주 보호주문 추적), `peakPrice?`(트레일링 극값) 추가(additive, 하위호환).

### 테스트
- `test/execution.test.ts` 12개 PASS(보호주문 롱/숏/트레일링, 정합, 동기화 mock, 드리프트, 사이징, 체결판정).

## 2. testnet 키 도착 시 배선 계획 (러너)

> 전부 `mode==="live"` + `liveGate.allowed` 가드 안에서만 동작(게이트 OFF면 dormant=현재와 무변화).

**P0-3 상주 스톱 (tickBot 라이브 진입 직후):**
1. 라이브 BUY 체결 성공 → adapter 확보(fillOrder가 resolve한 어댑터 재사용하도록 리팩토링).
2. `desired = planProtectiveOrders({positionSide, qty, entryAvg, peakPrice, sl/tp/trail})`.
3. `{restingIds} = await syncProtective(desired, position.protectiveIds ?? [], o=>adapter.placeOrder(o)..., id=>adapter.cancelOrder(id))`.
4. `position.protectiveIds = restingIds` 저장. 청산 시 전부 cancel.
5. 매 라이브 틱: peakPrice 갱신(고점/저점) → 트레일링이면 desired 재계산 → syncProtective(취소+재배치).

**P0-2 실잔고/포지션 동기화 (라이브 틱 시작):**
1. `getPositions()` → 심볼 실제 수량.
2. `computePositionDrift(localQty, exchangeQty)` → major면 거래소 채택(position_state 정정) + 알람.
3. 라이브 사이징: `sizeFromBalance(getBalance().cashBalance, price, pct)` 사용.

**P0-4 체결 reconcile:**
1. placeOrder 타임아웃/모호 실패 → `getOrderByClientId` → `classifyFillStatus` → filled면 반영, not_placed면 재시도 안전.
2. startup `resumeAll` 시 in-flight clientOrderId 조회로 복구.

**P0-1 지정가 라이브:** 봇/전략에 라이브 실행 선호(limit offset) 필드 추가 → fillOrder가 limit 전송 → 미체결 추적/취소/재주문(체결 reconcile과 결합). ※ testnet 검증 후.

## 3. testnet E2E 체크리스트 (검증 항목)
- [ ] 상주 SL이 거래소에 실제로 걸리는가(getOpenOrders 확인). 봇 종료 후에도 트리거되는가.
- [ ] 트레일링: 가격 상승 시 옛 SL 취소+새 SL 배치가 정상인가.
- [ ] 청산 시 잔여 보호주문이 모두 취소되는가(고아 주문 0).
- [ ] computePositionDrift가 실제 부분체결을 잡아내 정정하는가.
- [ ] sizeFromBalance가 잔고초과 거부를 막는가.
- [ ] 모호 실패 후 classifyFillStatus reconcile이 중복주문/유실을 막는가.
- [ ] 하드리밋(노셔널캡/allowlist/일일손실)과 보호주문이 충돌 없이 공존.

## 4. 결론
**키 없이 가능한 P0 코어·어댑터·테스트는 전부 준비됨.** 남은 건 러너 배선 + testnet 머니패스 검증인데,
이건 "스톱이 실제로 거래소에 걸리는지"를 눈으로 봐야 하므로 testnet 키가 전제다. 키가 오면 위 계획대로
**검증하며** 배선한다(검증 불가한 라이브 변이 코드를 미리 넣지 않는다 — 프로젝트 정직 원칙).
