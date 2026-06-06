/**
 * spread-symbols.ts — 복합전략 트리에서 spread 조건의 symbolB를 수집(순수 트리워크).
 * 러너/백테스트 툴이 이 목록으로 멀티심볼 데이터를 미리 페치 → auxSeries 주입(backtest≡live).
 */
import type { StrategyNode } from "../types/strategy";

const MAX_DEPTH = 50; // 검증 단계(MAX_NODE_DEPTH=20)보다 큰 안전 상한.

/** root_node를 순회해 spread 조건이 참조하는 상대심볼(symbolB) 집합을 반환(중복 제거). throw 안 함. */
export function collectSpreadSymbols(root: StrategyNode): string[] {
  const out = new Set<string>();
  const stack: Array<{ n: StrategyNode; d: number }> = [{ n: root, d: 0 }];
  while (stack.length) {
    const { n, d } = stack.pop()!;
    if (!n || typeof n !== "object" || d > MAX_DEPTH) continue;
    if (n.type === "condition") {
      const c = n.condition;
      if (c && c.type === "spread" && typeof c.symbolB === "string" && c.symbolB) out.add(c.symbolB);
      if (n.thenNode) stack.push({ n: n.thenNode, d: d + 1 });
      if (n.elseNode) stack.push({ n: n.elseNode, d: d + 1 });
    } else if (n.type === "composite" && Array.isArray(n.children)) {
      for (const child of n.children) stack.push({ n: child, d: d + 1 });
    }
  }
  return [...out];
}
