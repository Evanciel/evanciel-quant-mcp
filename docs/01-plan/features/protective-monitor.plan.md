# protective-monitor Planning Document

> **Summary**: 전략 봉 주기와 분리된 데몬 측 고빈도 보호 모니터 — 거래소 상주 SL/TP 미지원 브로커(KR: 키움/한투/토스)의 라이브 포지션을 ~10초 주기로 감시해 SL/TP/트레일링 위반 시 단일 `fillOrder` 안전경로로 즉시 시장가 청산. "거래소가 지원 안 해도 우리가 한다"의 달성 가능한 최대치.
>
> **Project**: quant-mcp
> **Version**: 0.1.0
> **Author**: Evanciel
> **Date**: 2026-06-25
> **Status**: Draft (승인 대기)

---

## Executive Summary

| Perspective | Content |
|-------------|---------|
| **Problem** | 라이브 SL/TP 소프트스톱의 반응 지연 = **전략 봉 주기**. `Runner.start`의 틱이 `setInterval(run, Math.max(15, interval_seconds)*1000)`(runner.ts:1550)이라 **일봉 봇은 하루 1번** 평가 → 장중 폭락 시 손절이 다음날까지 안 걸림. 바이낸스는 거래소 상주 SL/TP로 무관하나 **KR(키움/한투/토스)은 거래소가 상주 보호주문 미지원**(어댑터가 fail-closed로 거절, syncBotProtective 스킵)이라 이 폴링이 **유일한 방어**인데 봉 주기에 묶여 사실상 장중 보호 공백. |
| **Solution** | 전략 틱과 **독립된 고빈도(기본 10초) 보호 스윕**을 데몬에 추가. 열린 **라이브** 포지션(live=true, qty>0) 중 거래소 상주 SL/TP가 없는 브로커만 대상으로, `getPrice` 단건 현재가로 고정 SL/트레일링 SL/TP를 평가해 위반 시 기존 **단일 `fillOrder` 경로**로 시장가 청산. 봉 주기와 무관하게 초 단위 보호. |
| **Function/UX Effect** | 일봉/시간봉 KR 봇도 장중 급락에 **~10초 내 손절**. 갭하락은 다음 봉을 안 기다리고 즉시 청산. (선택) 텔레그램 손절 알림. 기존 게이트·하드리밋·멱등·감사로그 그대로 상속. |
| **Core Value** | 거래소 상주 주문의 핵심 효용(저지연·항시 감시)을 **데몬 측에서 최대한 복제**. 단일 안전경로 재사용으로 새 주문 루트·중복 코드 0. |

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | KR 라이브 포지션의 장중 손절 공백 제거(일봉 봇=하루 1번 평가 갭). 거래소 상주 미지원을 데몬 측 합성 보호로 메움. |
| **WHO** | KR 주식을 라이브 자동매매하는 사용자. 현재 메인넷 OFF라 latent이나, 라이브 전환 시 1순위 리스크. |
| **RISK** | 실거래 청산 경로. (1) **backtest≡live 불변식** — 봉마감 기준 백테와 장중 모니터 청산이 시점·가격이 달라질 수 있음. (2) **이중 청산** — 모니터와 전략 틱(또는 바이낸스 상주주문)이 동시에 매도. (3) getPrice **레이트리밋**. (4) **휴장/유동성 없는 시장**에 매도. |
| **SUCCESS** | 일봉 KR 봇 라이브(페이퍼/모의)에서 진입 후 장중 가격이 SL선 하회 시 다음 봉 전에 ~10초 내 시장가 청산 확인. 이중 청산 0. tsc 0 + 전체 테스트 무회귀 + 신규 단위/동시성 테스트 통과. |
| **SCOPE** | (1) 보호 스윕 루프 (2) SL/트레일링/TP 평가(순수 함수) (3) `fillOrder` 청산 연동 + 멱등·재진입 가드 공유 (4) 휴장/레이트리밋/fail-closed 처리 (5) 테스트. **제외**: 외부 이중화(2nd 인스턴스/클라우드), 워치독 하드닝, 텔레그램 알림(후속 스코프). |

---

## 1. Overview

### 1.1 Purpose
거래소 상주 보호주문을 지원하지 않는 브로커(KR)의 **라이브 보유 포지션**을, 전략 봉 주기와 무관하게 고빈도로 감시하여 SL/TP/트레일링 위반 즉시 시장가 청산하는 데몬 측 "합성 상주 보호"를 구현한다.

### 1.2 Background (검증된 현재 동작)
- 틱 = `Math.max(15, interval_seconds)`초. 일봉 봇 `interval_seconds=86400` → **틱·SL/TP 평가 1일 1회**. (runner.ts:1550)
- SL/TP는 엔진(`runCompositeBacktest` → engine.ts:819-839)이 **봉마감 종가/저가** 기준으로 평가하고, 라이브는 `derivePosition → planPositionDelta → fillOrder`로 미러링.
- KR 브로커는 `syncBotProtective`가 상주 보호주문 시도를 **스킵**(어댑터가 protective 타입 fail-closed 거절). → KR SL/TP는 **느린 폴링이 유일 방어**.
- `getPrice(symbol)` 단건 현재가는 **4개 브로커 모두 지원**(binance/kis/kiwoom/toss) → 모니터의 가격 소스로 사용 가능.
- 바이낸스는 거래소 상주 SL/TP(STOP_MARKET 등) + #6 체결 reconcile 완료 → 모니터 대상에서 기본 제외(중복·이중청산 방지).

### 1.3 The hard limit (정직하게)
모니터는 **우리 데몬이 살아있어야** 동작한다. 데몬+호스트+워치독이 전부 다운이면 보호 불가(거래소 상주 주문만이 그 경우를 커버). 따라서 본 작업은 "거래소 상주에 **근접**"이지 동일이 아니며, 완전 동치는 외부 이중화(별도 스코프)가 필요하다. 24/7 데몬 + 10초 스윕 + 기존 VBS 워치독으로 실무상 대부분 커버한다.

---

## 2. Design

### 2.1 핵심 결정 (검토 요청 — 기본값 + 근거)

| # | 결정 | 기본값 | 근거 / 대안 |
|---|------|--------|-------------|
| D1 | **대상 브로커** | KR(키움/한투/토스)만 | 바이낸스는 거래소 상주+reconcile 완료 → 중복/이중청산 위험. (대안: 전 브로커 백스톱 — 후속) |
| D2 | **메커니즘** | **단일 전역 스윕 타이머**(per-bot 아님) | 라이프사이클 단순(start/stop 1곳). 매 스윕 `listRunningBots` 순회. (대안: per-bot 타이머 — 복잡) |
| D3 | **주기** | 10초(env `QUANT_PROTECT_SWEEP_MS`, 클램프 3~60s) | 봉 주기와 독립. KR 레이트리밋 고려 상한. |
| D4 | **가격 소스** | `getPrice` 단건(현재가). 스윕당 심볼별 1회, 짧은 캐시/coalesce | 봉마감이 아닌 **실시간** 위반 감지가 목적. |
| D5 | **청산 경로** | 기존 `fillOrder(bot,"sell",qty,price,{posLive:true})` 재사용 | 단일 안전경로 불변식. 새 주문 루트 금지. 멱등키·게이트·감사 상속. |
| D6 | **backtest≡live** | **모니터는 라이브 전용 안전 오버레이**로 명시 | 백테는 봉마감 SL(보수적), 라이브 모니터는 장중(더 타이트). **보호는 백테보다 같거나 강함** → 사용자 자본 보호 방향이라 수용·문서화. 사이징/신호 소스는 여전히 엔진(불변). |
| D7 | **휴장/세션** | 시장 미개장이면 청산 시도 안 함(유동성 없음) — `isMarketOpen`/세션 게이트 재사용, 로그·(후속)알림 | 닫힌 KR 시장에 시장가 던지면 거부/슬리피지. |

### 2.2 동시성·멱등 (이중 청산 방지 — 최우선)
- 스윕은 전략 틱과 **동일한 per-bot 재진입 락**(`Runner.ticking` Set)을 공유: 봇이 틱 중이면 스윕 스킵, 스윕 중이면 틱 스킵. → 같은 봇에 매도 2건 동시 진입 불가.
- 청산은 `fillOrder`의 **봉 기준 멱등키**(`botId:lastIso:sell`)와 별개로, 모니터 청산은 **보호 전용 멱등키**(예: `botId:protectstop:<barIso 또는 분단위 버킷>`)로 같은 위반에 1회만. 청산 후 포지션 상태(qty=0)로 다음 스윕 자동 무동작.
- 바이낸스 제외(D1)로 거래소 상주주문 ↔ 모니터 이중청산 원천 차단.
- **모니터 청산 후 재진입 억제(중요)**: 모니터가 장중 청산하면 다음 전략 틱의 엔진(봉마감 기준)은 그 청산을 못 보고 여전히 '보유'를 원해 `planPositionDelta(curQty=0, want>0)`로 **재매수**할 수 있다. → 포지션/봇에 `protectiveExitBar`(청산된 봉 ISO) 마커를 남겨, 같은 봉에서는 전략 틱이 매수 신호를 평가하지 않도록 한다(엔진의 `sltpExited`(engine.ts:837 "같은 봉 stop→재매수 방지")와 동일 의미를 라이브 모니터로 확장). 다음 봉부터 정상 신호 복귀.

### 2.3 평가 로직 (순수 함수, 테스트 용이)
`evaluateProtectiveExit({ side:'long', entryAvg, peakPrice, price, sl, tp, trail })` → `{ hit: boolean, kind: 'sl'|'tp'|'trail', exitReason }`
- 고정 SL: `price <= entryAvg*(1-sl/100)`
- TP: `price >= entryAvg*(1+tp/100)`
- 트레일링: `peakPrice` 갱신(`max(peak, price)`) 후 `price <= peakPrice*(1-trail/100)`
- 기존 `protective.ts`/엔진 SL/TP 산식과 **동일 기준**으로 정렬(불일치 금지).

### 2.4 데이터 흐름
```
프로텍트 스윕(10s) ──> store.listRunningBots()
  └─ 각 봇: live position(live=true,qty>0) & 브로커 ∈ {kiwoom,kis,toss} & 세션 open?
       └─ getPrice(symbol)  (캐시/coalesce, 실패→스킵+로그 fail-closed)
       └─ peakPrice 갱신(setBotPositionState)
       └─ evaluateProtectiveExit(...)  hit?
            └─ ticking 락 획득 → fillOrder(bot,"sell",qty,px,{posLive:true, reason:'protect_<kind>'})
                 └─ liveGate ─ checkLimits ─ placeOrder(market) ─ 멱등 기록 ─ audit
```

---

## 3. Phases (PDCA Do)

1. **순수 평가 함수** `evaluateProtectiveExit` + 단위 테스트(SL/TP/트레일링 경계, 롱 only 현물).
2. **스윕 루프**: `Runner`에 전역 보호 타이머 추가(start/shutdown 연동, `unref`). 대상 필터(라이브/KR/세션). getPrice 캐시·coalesce.
3. **청산 연동**: `ticking` 락 공유 + 보호 멱등키로 `fillOrder` 호출. 페이퍼/라이브 분리 준수(페이퍼는 엔진 시뮬이 처리 → 모니터는 라이브만).
4. **세션·fail-closed·레이트리밋** 처리 + 로그/감사 이벤트(`protective_monitor_exit`).
5. **테스트**: 동시성(틱↔스윕 이중청산 0), 멱등(같은 위반 1회), backtest 무회귀(엔진/사이징 불변), KR getPrice 실패 fail-closed.
6. **검증**: tsc 0 + 전체 vitest + 페이퍼/모의 E2E(진입→장중 SL 하회→다음봉 전 청산) + 브라우저 대시보드 무회귀.

## 4. Risks & Mitigations
- **이중 청산** → 공유 재진입 락 + 보호 멱등키 + 바이낸스 제외. (테스트로 게이트)
- **backtest≡live 발산** → 라이브 안전 오버레이로 명시·문서화(D6). 사이징/신호 엔진 불변.
- **레이트리밋(KR)** → 스윕당 심볼 1회 + 캐시/coalesce + 상한 주기. 실패 fail-closed(스킵·재시도).
- **휴장 매도** → 세션 게이트(D7). 닫힌 시장엔 시도 안 함.
- **장기 갭(데몬 다운)** → 본 스코프 밖(외부 이중화 필요). 워치독으로 다운 창 최소화는 후속.

## 5. Success Criteria
- [ ] 일봉 KR 라이브(페이퍼/모의) 봇: 진입 후 장중 SL 하회 → 다음 봉 전 ~10초 내 시장가 청산.
- [ ] 틱↔스윕 이중 청산 0(동시성 테스트).
- [ ] tsc 0 + 기존 674 테스트 무회귀 + 신규 테스트 통과.
- [ ] 바이낸스 동작 불변(상주주문 유지, 모니터 미개입).
- [ ] backtest≡live: 사이징/신호 경로 무변경(엔진 단일 소스 유지).

## 6. Out of Scope (후속 후보)
- 외부 이중화(상시 2nd 인스턴스 / 클라우드 워치독) — 호스트 완전 다운 커버.
- 워치독 하드닝(재시작 가속·크래시 알림), 텔레그램 손절/공백 알림.
- 바이낸스 백스톱(상주주문 실패 시 모니터 폴백).
- 공매도/선물 숏 포지션 보호(현재 현물 롱 only).
