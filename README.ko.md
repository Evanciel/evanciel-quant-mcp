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

## 한마디로 뭐냐면

**채팅으로 매매 아이디어를 말하면, AI가 그걸 실제로 만들고, 과거 진짜 시세로 검증하고, 연습용 봇으로 돌려줍니다 — 코딩도, 거래소 키도 없이.**

- 🗣️ **말하면** — *"상승장에서 ETH가 눌릴 때 사고, FOMC 발표 전후엔 쉬어줘."*
- 🧪 **검증하면** — 바이낸스 실제 시세 기록을 다시 돌려보며 그 아이디어가 통했을지 보여주고, **좋아 보이는 결과가 사실은 운빨일 가능성을 경고**합니다.
- 🤖 **돌리면** — 24/7 *페이퍼*(가짜 돈) 봇으로 배포하고, 쉬운 말로 된 대시보드로 지켜봅니다.

일부러 정직합니다: **수익을 약속하지 않습니다.** 진짜 가치는 당신을 지키는 것(리스크 통제)과, 백테스트가 당신을 속이고 있을 때 알려주는 것(과적합 필터)입니다. 용어가 낯설면 → [용어 사전](#용어-사전--금융-몰라도-됨).

## 3단계로 어떻게 돌아가나

```
   말하기   ─►   백테스트   ─►   돌리고 지켜보기
 (당신의 말)   (실제 시세,        (페이퍼 봇 +
                정직한 검증)        실시간 대시보드)
```

1. **말하기** — 에이전트가 당신의 말을 *검증된 전략 트리*(작은 JSON 명세)로 바꿔줍니다.
2. **백테스트** — 실제 과거 시세로 전략을 돌린 뒤, 한 번도 안 본 데이터로 다시 검증("아웃오브샘플")해서 과적합에 속지 않게 합니다.
3. **돌리고 지켜보기** — 매 새 봉마다 매매하는 페이퍼 봇을 배포하고, 모든 걸 쉬운 말로 설명하는 대시보드를 엽니다.

세 단계 모두 **같은 엔진**이 돌립니다. 그래서 백테스트한 그대로 라이브가 돌아갑니다 — 깜짝 변수 없음.

---

## ⚠️ 정직한 포지셔닝: 알파가 아니라 리스크 필터

quant-mcp는 알파(초과수익)를 찾아준다고 **주장하지 않습니다**. 이런 류의 리테일 인프라에서 방향성 알파는 ≈ 0이라는 게 딥리서치 결론입니다(243번의 아웃오브샘플 최적화 → 견고한 알파 0, 과적합 확인). 대신 *진짜로* 가치 있는 것을 줍니다:

- 🛡️ **리스크 통제** — 포지션 사이징(EWMA 변동성 타게팅 / ATR / 분수 Kelly), MDD 서킷브레이커, 포트폴리오 히트, 거래소 상주 스톱·트레일링 계산.
- 🔬 **거짓 발견 필터** — Deflated / Probabilistic Sharpe(DSR/PSR), 워크포워드 OOS 게이팅. *팩토리 툴이 대부분의 후보를 기각하는 건 의도된 동작이지 버그가 아닙니다.*
- 🧩 **표현력** — 조합형 전략 트리(지표 × 레짐 × 세션 × 페어 × 멀티타임프레임 × 캘린더 이벤트 × 스크리너)를 **하나의 검증 스키마**로, 그리고 **backtest ≡ live 동등성**(같은 순수 함수가 백테스트·페이퍼·라이브를 모두 구동).

기대수익을 광고하는 툴은 하나도 없습니다.

---

## 목차

- [한마디로 뭐냐면](#한마디로-뭐냐면)
- [3단계로 어떻게 돌아가나](#3단계로-어떻게-돌아가나)
- [빠른 시작](#빠른-시작)
- [에이전트가 무엇을 만들 수 있나](#에이전트가-무엇을-만들-수-있나)
- [툴 레퍼런스 (22개)](#툴-레퍼런스-22개)
- [전략 표현력](#전략-표현력)
- [봇 & 실시간 대시보드](#봇--실시간-대시보드)
- [리스크 & 실행 레이어](#리스크--실행-레이어)
- [아키텍처](#아키텍처)
- [로드맵](#로드맵)
- [안전](#안전)
- [용어 사전](#용어-사전--금융-몰라도-됨)
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

`open_dashboard`는 `127.0.0.1`에 실시간 HTML 대시보드를 띄웁니다(런치별 랜덤 토큰, 바이낸스 공개 WS로 실시간 미실현손익). **일반인용**으로 만들었습니다: 쉬운 말 전략 요약("상승 추세일 때만 과매도에서 매수"), 🟢 수익 / 🔴 손실 / ⚪ 대기 배지, 실현·미실현 손익, 멀티심볼 스캐너 포지션 — 전문 표기는 "자세히" 토글로.

**프로 차트(트레이딩뷰급, 유료 라이브러리 없이):** `lightweight-charts` v5 기반 — 1분~월봉, **켜고 끄는 지표 18종 + 파라미터 조정**(볼린저 σ, 슈퍼트렌드 배수, MACD 단/장/시그널, 스토캐스틱 K/D 등), **보조지표 패널 분리**, 차트 위 **드로잉 툴**(추세선/수평선, 봇별 localStorage 영속), 봇 전략 지표 + 진입/손절/익절 마커, **실시간 갱신**(코인=바이낸스 kline WS, 국내주식=폴링), **시각 KST 통일**.

**수동 매매 & 보호주문(BYOK, testnet 게이트):** 봇 카드에서 바로 시장가/지정가 **매수/매도**, 그리고 **차트에서 익절/손절선을 끌어** 바이낸스 현물 **OCO**(한쪽 체결 시 다른쪽 자동취소: 익절 체결되면 손절 자동취소, 반대도) 주문을 겁니다. 모든 주문은 봇과 *동일한* 안전 파이프라인을 거칩니다 — `liveGate`(마스터 스위치 OFF면 testnet/mock만) → 서버에서 실보유 수량·방향 재검증(클라 값 불신) → 노셔널 캡 → **2단계 확인토큰**(미리보기 → 확정, 해시 바인딩, 단일사용, 5분 TTL) → 감사로그. 이 기능들은 대시보드에서만 동작하며 메인넷은 **기본 OFF**.

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
- **수동 보호주문(testnet 검증):** 차트에서 익절/손절선을 끌면 바이낸스 현물 **OCO** — 거래소가 손절과 익절을 묶음으로 들고 있어 봇 프로세스와 무관하게 보호됩니다. 동일한 `liveGate` + 실보유 재검증 + 캡 + 2단계 확인토큰 경유, 메인넷은 마스터 스위치 전까지 OFF.

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
- ✅ 머니패스 Binance **testnet** 검증(진입 → 상주 SL/TP → 취소 → 청산)
- ✅ 프로 대시보드: 트레이딩뷰급 차트(지표 18종+파라미터 조정, 보조지표 패널 분리, 드로잉 툴, 실시간 갱신, KST 축)
- ✅ 수동 매매 + 차트 드래그 익절/손절 **OCO** 보호주문 — 동일 2단계 토큰 안전 파이프라인, testnet 검증
- ✅ 메인넷 파일럿 준비: GO/NO-GO 사전점검(`verify-mainnet-readiness.ts`) + [런북](docs/mainnet-pilot-runbook.md) — 출금권한 OFF / IP / 하드리밋 검사, **주문 0건**
- ⏳ 메인넷 파일럿(실돈 — 사장님 결정; 소액·마스터 스위치) · 지정가 · 선물 보호주문
- ⏳ 비크립토 데이터(주식/FX), 호가/마이크로구조, 옵션

---

## 안전

- **기본 키리스** — 분석 툴은 *공개* 시장 데이터만 읽습니다. 계정을 보지도, 거래하지도 않습니다.
- **페이퍼 우선** — 거래소 키 *그리고* 마스터 스위치(`LIVE_TRADING_ENABLED`)를 둘 다 켜야 라이브.
- **서버측 하드리밋** — 노셔널캡, 심볼 allowlist, 일일손실 서킷브레이커(LLM이 우회 불가).
- **2단계 주문 확인** — `place_order`는 fail-closed: 프리뷰가 토큰 반환, 동일 인자 + 토큰이어야 실행.
- **대시보드** — `127.0.0.1` 전용 바인딩, 런치별 랜덤 토큰, 읽기전용 포지션/플랜.
- **키는 채팅으로 절대 X** — CLI 마법사(`npx quant-mcp setup`), 대시보드 ⚙️ 설정 폼, 또는 환경변수로 저장. 키는 `~/.quant-mcp/credentials.env`(chmod 600, gitignore)에만 저장되고 마스킹으로만 보이며 다시 읽을 수 없습니다.
- **메인넷 사전점검** — 실돈 거래 전 `npx tsx scripts/verify-mainnet-readiness.ts`로 읽기전용 GO/NO-GO 점검(env=live·마스터스위치·키유효·**출금권한 OFF**·IP제한·하드리밋 자가검증) — **주문 0건**. [메인넷 파일럿 런북](docs/mainnet-pilot-runbook.md) 참고.

### 거래소 키 넣기 — *키만 넣으면 바로 매매*
마법사/대시보드에서 **실거래(live)** 를 고르면 마스터 스위치 + 안전 기본값(주문당 한도·일일손실 서킷)을 **자동**으로 켜줍니다. 환경변수 5개 따로 안 만져도 됩니다.
```bash
npx quant-mcp setup     # A) 마법사: 연습(testnet)/실거래(live) → 키 입력 → "출금 껐죠?" → 끝
```
**B)** 대시보드 → **⚙️ API 키 설정** → 키 입력 후 **💸 실거래 모드** 토글(한도+출금OFF 체크). 긴급 끄기(페이퍼 전환)도 버튼 하나.
**C)** 환경변수/시크릿 매니저(고급; MCP 설정 `env`가 파일보다 우선). 이 경우에도 마스터 ON·캡 미설정이면 안전 기본 캡 적용. [`SETUP-LIVE.md`](SETUP-LIVE.md) 참고.

라이브 거래를 켜기 전 [`SETUP-LIVE.md`](SETUP-LIVE.md)를 먼저 읽으세요.

---

## 용어 사전 — 금융 몰라도 됨

위 표에 나온 매매 용어들을 쉬운 말로 풀면:

| 용어 | 쉬운 말 |
|---|---|
| **백테스트** | 전략을 과거 시세에 다시 돌려서 *얼마나 잘됐을지* 보는 것. |
| **아웃오브샘플(OOS)** | 전략이 한 번도 "안 본" 데이터로 검증 — 과거를 그냥 외운 게 아닌지 정직하게 확인하는 법. |
| **과적합(오버피팅)** | 과거 데이터에만 딱 맞춰서 멋져 보이지만 실전에선 무너지는 전략. |
| **샤프 지수** | 위험 대비 수익. 높을수록 굴곡 없이 꾸준한 수익. |
| **PSR / DSR** (확률적/디플레이티드 샤프) | 좋아 보이는 결과가 운빨일 확률을 추정하는 통계. **거짓 발견을 걸러내는** 데 씁니다. |
| **레짐** | 시장의 지금 "분위기" — 상승 추세, 하락 추세, 횡보(지지부진), 또는 변동성 폭발. |
| **포지션 사이징** | *얼마나* 살지. 변동성/ATR/Kelly로 크기를 정하면 한 번의 실수로 깡통 차는 걸 막아줍니다. |
| **변동성 타게팅 · ATR · Kelly** | 지금 얼마나 위험한지에 따라 매매 크기를 정하는 세 가지 방법. |
| **드로다운(MDD)** | 고점에서 얼마나 떨어졌는지. 이게 커지면 서킷브레이커가 위험을 줄입니다. |
| **손절 · 트레일링 스탑** | 손실을 자동으로 끊는 매도 주문(트레일링 = 가격 오름을 따라가며 수익을 잠금). |
| **TP 라더 · 스케일인 · 피라미딩** | 익절을 나눠서 · 물타기 · 불타기 — 내장 포지션 관리. |
| **페어 / 스프레드 / z-score** | 두 코인의 방향이 아니라 둘 *사이의 간격*에 베팅. |
| **레짐 / 앵커 / MTF / 이벤트 조건** | 상승장에서만 · 당일 시가 대비(갭 매매) · 상위 시간대로 확인 · FOMC 회피/매매. |
| **스캐너** | 리스트에서 상위 N개 코인(예: 가장 많이 오른 종목)을 자동으로 골라 매매. |
| **페이퍼 트레이딩** | 가짜 돈으로 하는 연습 모드 — 로직은 똑같고 리스크는 0. |
| **backtest ≡ live(동등성)** | 테스트한 그대로가 실제로 돌아감 — 숨은 차이 없음. |
| **MCP (Model Context Protocol)** | AI 에이전트(Claude, Cursor…)가 이런 외부 툴을 쓰게 해주는 공개 표준. |
| **BYOK** | "키 직접 보유" — 실거래용 거래소 API 키를 직접 넣는 것(기본 꺼짐). |

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
