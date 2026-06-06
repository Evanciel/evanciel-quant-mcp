/**
 * calendars.ts — 일정(스케줄) 이벤트 캘린더. 이벤트 조건의 명명 캘린더(calendar:"FOMC") 소스 + 트리 수집/주입 헬퍼.
 *
 * 핵심 통찰(정직): FOMC/CPI/NFP 같은 '일정이 사전 확정된' 매크로 이벤트는 날짜가 사실(史實)이라 백테스트 가능
 * (예측불가한 뉴스/감성과 다름). 크립토는 FOMC/CPI에 강하게 반응 → "FOMC 2시간 전 청산" 류 표현 가치 큼.
 *
 * ⚠️ 정밀도 주의: 내장 FOMC는 '정책결정 발표(미국 동부 오후 2시) 시각'의 근사치(EST=19:00 UTC / EDT=18:00 UTC)다.
 * 시간 단위 윈도우(hoursBefore/After)엔 충분하나, 분 단위 정밀이 필요하거나 다른 이벤트(실적 등)는
 * **조건의 인라인 times(에이전트가 정확한 ISO 제공)를 쓰는 것을 권장**한다(외부데이터 0, backtest≡live 완벽).
 */
import type { StrategyNode } from "../types/strategy";

// FOMC 정책결정 발표일(둘째 날 ~14:00 ET). DST: EDT(3월중순~11월초)=18:00 UTC, EST=19:00 UTC.
// 출처: Federal Reserve 공개 일정. 라이브 전 verify 권장.
export const FOMC: string[] = [
  // 2023
  "2023-02-01T19:00:00Z", "2023-03-22T18:00:00Z", "2023-05-03T18:00:00Z", "2023-06-14T18:00:00Z",
  "2023-07-26T18:00:00Z", "2023-09-20T18:00:00Z", "2023-11-01T18:00:00Z", "2023-12-13T19:00:00Z",
  // 2024
  "2024-01-31T19:00:00Z", "2024-03-20T18:00:00Z", "2024-05-01T18:00:00Z", "2024-06-12T18:00:00Z",
  "2024-07-31T18:00:00Z", "2024-09-18T18:00:00Z", "2024-11-07T19:00:00Z", "2024-12-18T19:00:00Z",
  // 2025
  "2025-01-29T19:00:00Z", "2025-03-19T18:00:00Z", "2025-05-07T18:00:00Z", "2025-06-18T18:00:00Z",
  "2025-07-30T18:00:00Z", "2025-09-17T18:00:00Z", "2025-10-29T18:00:00Z", "2025-12-10T19:00:00Z",
  // 2026 (예정 — verify)
  "2026-01-28T19:00:00Z", "2026-03-18T18:00:00Z", "2026-04-29T18:00:00Z", "2026-06-17T18:00:00Z",
  "2026-07-29T18:00:00Z", "2026-09-16T18:00:00Z", "2026-10-28T18:00:00Z", "2026-12-09T19:00:00Z",
];

/** 내장 명명 캘린더 레지스트리. 이름→ISO 시각 배열. */
export const BUILTIN_CALENDARS: Record<string, string[]> = { FOMC };

const MAX_DEPTH = 50;

/** root_node를 순회해 event 조건이 참조하는 명명 캘린더 이름 집합 반환(인라인 times는 주입 불필요). */
export function collectEventCalendars(root: StrategyNode): string[] {
  const out = new Set<string>();
  const stack: Array<{ n: StrategyNode; d: number }> = [{ n: root, d: 0 }];
  while (stack.length) {
    const { n, d } = stack.pop()!;
    if (!n || typeof n !== "object" || d > MAX_DEPTH) continue;
    if (n.type === "condition") {
      const c = n.condition;
      if (c && c.type === "event" && typeof c.calendar === "string" && c.calendar) out.add(c.calendar);
      if (n.thenNode) stack.push({ n: n.thenNode, d: d + 1 });
      if (n.elseNode) stack.push({ n: n.elseNode, d: d + 1 });
    } else if (n.type === "composite" && Array.isArray(n.children)) {
      for (const child of n.children) stack.push({ n: child, d: d + 1 });
    }
  }
  return [...out];
}

/** 명명 캘린더 이름들 → epoch(ms) 정렬 배열 맵. 미등록/빈 캘린더는 제외(엔진에서 fail-closed). */
export function buildEventCalendars(names: string[], registry: Record<string, string[]> = BUILTIN_CALENDARS): Record<string, number[]> {
  const out: Record<string, number[]> = {};
  for (const name of names) {
    const iso = registry[name];
    if (!Array.isArray(iso) || iso.length === 0) continue;
    const ms = iso.map((s) => Date.parse(s)).filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
    if (ms.length) out[name] = ms;
  }
  return out;
}
