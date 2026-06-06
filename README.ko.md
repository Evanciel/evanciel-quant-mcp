<div align="center">

<img src="docs/banner.svg" alt="quant-mcp" width="100%"/>

**AI 에이전트를 위한 조합형 백테스트·리스크·페이퍼 트레이딩 엔진 — Model Context Protocol 기반.**

어떤 MCP 에이전트(Claude, Cursor 등)든 자연어로 매매 전략을 검증된 JSON 트리로 설계하고, 아웃오브샘플로 엄격히 백테스트하고, 24/7 페이퍼 봇으로 돌리고, 실시간 대시보드로 지켜볼 수 있습니다.

[![CI](https://github.com/Evanciel/evanciel-quant-mcp/actions/workflows/ci.yml/badge.svg)](https://github.com/Evanciel/evanciel-quant-mcp/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Node](https://img.shields.io/badge/node-%3E%3D22-green.svg)](package.json)
[![MCP](https://img.shields.io/badge/MCP-stdio-blue.svg)](https://modelcontextprotocol.io)
[![tests](https://img.shields.io/badge/tests-95%20passing-brightgreen.svg)](test)
[![keys](https://img.shields.io/badge/data-keyless%20(Binance%20public)-orange.svg)](src/data/binance-public.ts)

[English](README.md) · **한국어**

</div>

---

## ⚠️ 정직한 포지셔닝: 알파가 아니라 리스크 필터

quant-mcp는 알파(초과수익)를 찾아준다고 **주장하지 않습니다**. 이런 류의 리테일 인프라에서 방향성 알파는 ≈ 0이라는 게 딥리서치 결론입니다(243번의 아웃오브샘플 최적화 → 견고한 알파 0, 과적합 확인). 대신 *진짜로* 가치 있는 것을 줍니다:

- 🛡️ **리스크 통제** — 포지션 사이징(EWMA 변동성 타게팅 / ATR / 분수 Kelly), MDD 서킷브레이커, 포트폴리오 히트, 거래소 상주 스톱·트레일링 계산.
- 🔬 **거짓 발견 필터** — Deflated / Probabilistic Sharpe(DSR/PSR), 워크포워드 OOS 게이팅. *팩토리 툴이 대부분의 후보를 기각하는 건 의도된 동작이지 버그가 아닙니다.*
- 🧩 **표현력** — 조합형 전략 트리(지표 × 레짐 × 세션 × 페어 × 멀티타임프레임 × 캘린더 이벤트 × 스크리너)를 **하나의 검증 스키마**로, 그리고 **backtest ≡ live 동등성**(같은 순수 함수가 백테스트·페이퍼·라이브를 모두 구동).

기대수익을 광고하는 툴은 하나도 없습니다.

---

## 목차

- [빠른 시작](#빠른-시작)
- [에이전트가 무엇을 만들 수 있나](#에이전트가-무엇을-만들-수-있나)
- [툴 레퍼런스 (22개)](#툴-레퍼런스-22개)
- [전략 표현력](#전략-표현력)
- [봇 & 실시간 대시보드](#봇--실시간-대시보드)
- [리스크 & 실행 레이어](#리스크--실행-레이어)
- [아키텍처](#아키텍처)
- [로드맵](#로드맵)
- [안전](#안전)
- [기여](#기여)
- [라이선스](#라이선스)

---

## 빠른 시작

quant-mcp는 stdio MCP 서버입니다 — **MCP를 지원하는 어떤 에이전트**(Claude Desktop, Claude Code, Cursor, Continue 등)든 22개 툴을 쓸 수 있습니다. API 키 불필요(데이터는 바이낸스 공개 REST).

### 소스에서 (지금 바로 동작)

```bash
git clone https://github.com/Evanciel/evanciel-quant-mcp.git
cd evanciel-quant-mcp
npm install
npm test        # 95/95 — 서버 기동 + 툴 동작 확인
```

MCP 클라이언트에 등록(`ABSOLUTE_PATH`를 clone 위치로 교체):

```json
{
  "mcpServers": {
    "quant-mcp": {
      "command": "npx",
      "args": ["-y", "tsx", "ABSOLUTE_PATH/evanciel-quant-mcp/src/mcp-server/index.ts"]
    }
  }
}
```

- **Claude Code (CLI):** `claude mcp add quant-mcp -- npx -y tsx ABSOLUTE_PATH/evanciel-quant-mcp/src/mcp-server/index.ts`
- **Claude Desktop:** `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) · `%APPDATA%\Claude\claude_desktop_config.json` (Windows)
- **Cursor:** `.cursor/mcp.json`

서버는 stderr에 `quant-mcp server ready (stdio) — 22 tools`를 출력합니다.

### npm으로 (발행 후)

```json
{ "mcpServers": { "quant-mcp": { "command": "npx", "args": ["-y", "quant-mcp"] } } }
```

> 바로 붙여넣을 수 있는 프롬프트는 [`examples/usage.md`](examples/usage.md), 전체 설정은 [`examples/mcp-config.json`](examples/mcp-config.json) 참고.

---

## 에이전트가 무엇을 만들 수 있나

에이전트에게 자연어로 말하면, 전략 트리를 조립하고 검증하고 백테스트하고 (원하면) 페이퍼 봇으로 배포합니다:

> *"상승 추세 레짐일 때만 RSI 과매도에서 매수하되, FOMC 전후 6시간은 쉬는 ETH 전략을 만들어줘. 1시간봉으로 백테스트해서 아웃오브샘플 게이트를 통과하는지 알려줘. 통과하면 페이퍼 봇으로 돌리고 대시보드 열어줘."*

> *"매일 아침 9시(KST)에 BTC·ETH·SOL·BNB 중 1시간 모멘텀 상위 2개를 골라서 모멘텀 매매해줘."*

> *"3개 코인 바스켓을 역변동성 가중으로 포지션 사이즈 제안해줘."*

위 전부 **지금** 표현 가능하고, OOS+DSR로 백테스트되며, 페이퍼 봇으로 실행됩니다.

---

## 툴 레퍼런스 (22개)

모든 툴은 검증된 순수 함수와 1:1 대응하며 *"알파가 아니라 리스크 필터"* 고지를 담고 있습니다.

### 📊 분석 & 백테스트 (8)

| 툴 | 설명 |
|---|---|
| `validate_strategy` | 복합 전략 트리 검증(재귀/가중/시간/스캐너 경계). 모든 툴의 상류 게이트. |
| `backtest` | 백테스트 + 워크포워드 70/30 OOS + PSR(과적합 탐지). |
| `backtest_short` | 숏 백테스트(sell=진입, buy=커버); 롱과 동일 신호평가 → backtest≡live. |
| `detect_regime` | ADX / Kaufman ER / ATR% → 추세/횡보/고변동성. |
| `derivatives_signal` | 펀딩(연율화) / OI 4분면 / 롱숏 틸트 / 테이커 흐름(바이낸스 fapi). |
| `suggest_position_size` | EWMA 변동성 타게팅 / ATR / 분수 Kelly 사이징. |
| `portfolio_risk` | 히트 / MDD 서킷브레이커 / 상관 보정(순수, 계정 불필요). |
| `strategy_factory` | 대량 OOS + Deflated Sharpe 생존자 필터. 대부분 기각이 정상. |

### 🔎 스크리닝·포트폴리오·이벤트 (3)

| 툴 | 설명 |
|---|---|
| `scan_universe` | 심볼 리스트를 gapPct / roc / relVolume / rangePct로 크로스섹셔널 랭킹 → 상위 N. |
| `allocate_portfolio` | 자본 배분: 동등 / 역변동성(리스크패리티 대각) / 목표변동성. |
| `list_events` | 내장 일정 이벤트 캘린더(FOMC) — `event` 조건용. |

### 🤖 전략·봇·대시보드 (7)

| 툴 | 설명 |
|---|---|
| `save_strategy` | 복합 전략(또는 스캐너) 검증 + 로컬 저장. |
| `create_bot` | 저장된 전략으로 페이퍼 봇 생성. |
| `start_bot` / `stop_bot` | 봇 가동/중지(매 봉마다 백테스트 엔진 재사용 평가 → backtest≡live). |
| `list_bots` / `get_bot_status` | 봇 목록 / 포지션 + 최근 체결 + 로그 조회. |
| `open_dashboard` | 로컬(127.0.0.1) 실시간 HTML 대시보드 실행. |

### 🔐 라이브 거래 — BYOK(키 직접 보유) (4)

| 툴 | 설명 |
|---|---|
| `live_status` | 어떤 브로커/환경(testnet/mock/live)이 설정됐는지 + 마스터 스위치 + 하드리밋(키 노출 0). |
| `get_positions` / `get_balance` | 실제 거래소 포지션/잔고 조회(읽기전용, BYOK). |
| `place_order` | 실주문 — **fail-CLOSED 2단계 확인 토큰** + 서버측 하드리밋(노셔널캡/심볼 allowlist/일일손실 서킷). 메인넷은 `LIVE_TRADING_ENABLED=true` 필요. |

> **기본은 페이퍼.** 키와 마스터 스위치를 둘 다 설정해야 라이브가 켜집니다. 메인넷은 testnet 검증 뒤에만 게이트가 열립니다.

---

## 전략 표현력

전략은 **조합형 JSON 트리**입니다. 노드 타입 4종:

| 노드 | 의미 |
|---|---|
| `leaf` | 규칙 기반 전략(지표 조건 → 매수/매도). |
| `condition` | `IF <조건> THEN <노드> ELSE <노드>` — 어떤 하위 전략이든 게이팅. |
| `composite` | 자식들을 `priority`(우선순위) 또는 `weighted`(가중)로 결합. |
| `scanner` | 유니버스 스크리닝 → 랭킹 → 상위 N 선정 → 하위 전략 적용(벽시계 스케줄 옵션). |

…그리고 **조건 타입 7종**(전부 backtest≡live):

| 조건 | 표현 |
|---|---|
| `indicator` | 21개 지표(RSI, MACD, SMA/EMA, 볼린저, ADX 등) — `timeframe` 지정 시 **멀티타임프레임**("1h 추세 + 5m 진입"). |
| `time` | 월 / 분기 / 요일 / **시** / **분**(+ `tz`) — 시간대 전략. |
| `regime` | 시장 레짐 ∈ {trend_up, trend_down, range, high_vol} — 레짐 게이팅. |
| `anchor` | 가격 vs 세션 기준값(시가 / 전일종가 / 세션 고저 / VWAP) × 배수 — 갭앤고 / ORB. |
| `spread` | 다른 심볼과의 페어: 비율 / 차이% / z-score — 페어 / 스탯아브. |
| `event` | 일정 이벤트 ±N시간 윈도우(**FOMC 캘린더** 또는 직접 넣는 `times` — 실적 등). |
| `performance` | 최근 수익률 / 드로다운 / 승률 게이팅. |

…여기에 어떤 전략에든 풍부한 **포지션 관리**: `stopLoss`, `takeProfit`, **TP 라더**(부분 익절), **스케일인**(물타기), **피라미딩**(불타기), **트레일링 스탑**, **숏 / 선물**(testnet 검증).

<details>
<summary><b>전략 트리 예시</b> — 상승장에서만 RSI 눌림 매수, 1h 확인, FOMC 회피, TP 라더</summary>

```jsonc
{
  "id": "root", "type": "condition", "name": "FOMC 회피",
  "condition": { "type": "event", "calendar": "FOMC", "hoursBefore": 6, "hoursAfter": 6 },
  "thenNode": { "id": "flat", "type": "leaf", "name": "관망", "strategy": { /* 매매 안 함 */ } },
  "elseNode": {
    "id": "regime", "type": "condition", "name": "상승장만",
    "condition": { "type": "regime", "in": ["trend_up"] },
    "thenNode": {
      "id": "mtf", "type": "condition", "name": "1h 추세 필터",
      "condition": { "type": "indicator", "indicator": "sma", "params": { "period": 50 }, "operator": "gt", "value": 0, "timeframe": "1h" },
      "thenNode": { "id": "leaf", "type": "leaf", "name": "RSI 눌림", "strategy": {
        "symbol": "ETHUSDT",
        "rules": [{ "action": "buy", "conditions": [{ "indicator": "rsi", "params": { "period": 14 }, "operator": "lt", "value": 35 }], "quantityPercent": 100 }]
      } }
    }
  }
}
```
배포: `save_strategy({ tree, stopLossPercent: 5, tpLadder: [{pct:5,sellPct:50},{pct:10,sellPct:50},{pct:15,sellPct:100}] })`.

</details>

---

## 봇 & 실시간 대시보드

`save_strategy` → `create_bot` → `start_bot` 으로 봇을 돌리면, 매 닫힌 봉마다 **같은 백테스트 엔진**으로 재평가합니다(그래서 라이브가 백테스트를 그대로 따라가며, 라더 부분 체결까지 일치). 상태는 로컬 `node:sqlite` 스토어에 저장 — 계정도, 클라우드도 없습니다.

`open_dashboard`는 `127.0.0.1`에 실시간 HTML 대시보드를 띄웁니다(런치별 랜덤 토큰, 읽기전용, 바이낸스 공개 WS로 실시간 미실현손익). **일반인용**으로 만들었습니다: 쉬운 말 전략 요약("상승 추세일 때만 과매도에서 매수"), 🟢 수익 / 🔴 손실 / ⚪ 대기 배지, 실현·미실현 손익, 멀티심볼 스캐너 포지션 — 전문 표기는 "자세히" 토글로.

<div align="center">
  <img src="docs/img/dashboard.png" alt="quant-mcp 대시보드" width="80%"/>
  <br/>
  <sub>일반인용 실시간 대시보드 — 사람 말로 된 전략, 수익/손실 배지, 실현·미실현 손익, 멀티심볼 스캐너 포지션.</sub>
</div>

---

## 리스크 & 실행 레이어

- **사이징 & 포트폴리오:** `suggest_position_size`, `portfolio_risk`, `allocate_portfolio` — 변동성 타게팅, ATR, Kelly, 히트, MDD 서킷브레이커, 상관 보정.
- **거짓 발견 게이트:** 워크포워드 OOS, PSR/DSR(deflated Sharpe), `strategy_factory`.
- **실행 코어(키 불필요, 테스트 완료):** 거래소 상주 스톱/익절/트레일링 계획(`planProtectiveOrders`), 거래소 대비 포지션 드리프트 정정, 실잔고 기반 사이징, 체결 상태 판정 — 봇 프로세스가 죽어도 손절이 보호됩니다. (라이브 배선은 testnet 게이트; `docs/p0-execution-layer.md` 참고.)

---

## 아키텍처

```
src/core/         이식 가능한 부수효과 0 퀀트 엔진
  backtest/         지표, 엔진, 메트릭, 레짐, deflated-sharpe, 숏엔진
  strategy/         spread-symbols, mtf(멀티타임프레임)
  scanner/          rank(크로스섹셔널 스크리닝)
  calendar/         일정 이벤트 캘린더(FOMC)
  position/         ladder(TP/스케일인/피라미딩), short
  risk/             sizing, portfolio, allocation
  execution/        보호주문, reconcile (P0 — 키 불필요)
  validation/       전체 전략 트리용 단일 Zod 스키마
  types/            전략 타입
src/data/         binance-public.ts — 키 없는 바이낸스 REST(klines 페이지네이션 + fapi)
src/store/        node:sqlite 로컬 스토어(봇, 전략, 거래, 로그)
src/runner/       페이퍼/라이브 봇 러너(백테스트 엔진 재사용 → backtest≡live)
src/dashboard/    127.0.0.1 실시간 HTML 대시보드
src/brokers/      멀티브로커 어댑터(바이낸스 + 한국투자/KIS + 키움) + 안전 게이트
src/mcp-server/   stdio MCP 서버 + 22개 툴
```

**설계 원칙:** 라이브 러너가 `runCompositeBacktest`를 *재사용*합니다. 그래서 조건 타입 추가 = 정확히 3개 파일(types + validation + engine) 수정이면 라이브가 자동 상속 — backtest ≡ live가 구조적으로 보장됩니다.

---

## 로드맵

- ✅ 이식 가능한 코어 + 키 없는 바이낸스 데이터
- ✅ MCP 서버 + 22개 툴(분석, 스크리닝, 포트폴리오, 이벤트, 봇, 라이브 BYOK)
- ✅ 전략 표현력: indicator/time/regime/anchor/spread/MTF/event 조건 + 스캐너 노드
- ✅ 포지션 관리: SL/TP, TP 라더, 스케일인, 피라미딩, 트레일링, 숏/선물
- ✅ 페이퍼 봇 러너 + 실시간 대시보드
- ✅ P0 실행 코어(상주 스톱 / reconcile / 실잔고 사이징) — 키 불필요, 테스트 완료
- ⏳ 라이브 실행 배선 + 머니패스 E2E(testnet 게이트)
- ⏳ 비크립토 데이터(주식/FX), 호가/마이크로구조, 옵션

---

## 안전

- **기본 키리스** — 분석 툴은 *공개* 시장 데이터만 읽습니다. 계정을 보지도, 거래하지도 않습니다.
- **페이퍼 우선** — 거래소 키 *그리고* 마스터 스위치(`LIVE_TRADING_ENABLED`)를 둘 다 켜야 라이브.
- **서버측 하드리밋** — 노셔널캡, 심볼 allowlist, 일일손실 서킷브레이커(LLM이 우회 불가).
- **2단계 주문 확인** — `place_order`는 fail-closed: 프리뷰가 토큰 반환, 동일 인자 + 토큰이어야 실행.
- **대시보드** — `127.0.0.1` 전용 바인딩, 런치별 랜덤 토큰, 읽기전용, 시크릿 미전송.

라이브 거래를 켜기 전 [`SETUP-LIVE.md`](SETUP-LIVE.md)를 먼저 읽으세요.

---

## 기여

이슈와 PR 환영합니다. 컨벤션:

```bash
npm run typecheck   # tsc --noEmit (클린 필수)
npm test            # vitest (95/95)
npm run build       # esbuild 단일파일 번들 → dist/
```

새 조건 타입은 **3-파일 패턴**(`types/strategy.ts` + `validation/composite-node.ts` + `backtest/engine.ts`)을 따르면 러너가 자동 상속합니다. 코어 함수는 **순수**(I/O 없음)하게 유지하세요 — backtest ≡ live가 성립하도록.

---

## 라이선스

[MIT](LICENSE) © Evanciel

> 이식 가능한 코어는 모(母) 프로젝트에서 추출돼 적대적 멀티에이전트 이식성·정합성 검증을 거쳤습니다. **투자 조언이 아닙니다 — 연구·교육용.**
