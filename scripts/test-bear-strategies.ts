/**
 * test-bear-strategies.ts — "하락장 대응" 정직 백테스트(옵션 B).
 *
 * 전제(직전 검증): 순수 dip-buy(급락 매수)는 하락장에서 칼날잡기 → 일관 엣지 없음(알파≈0).
 * 엔지니어링 정답 = "하락장에서 매수로 이기기"가 아니라 ① 회피(레짐필터) ② 숏(추세추종).
 * 같은 하락장 포함 실 Binance 데이터로 3가지를 나란히 비교한다. 미화 없이 진짜 수익/MDD/거래/승률 출력.
 *
 *   A. 베이스라인 — 순수 dip-buy 롱 (roc<-d 매수 / 반등 청산, SL3/TP5)
 *   B. 회피(레짐필터) — 동일 dip-buy 를 condition 노드로 감싸 trend_down 레짐일 땐 비활성(신규진입 차단)
 *   C. 숏(추세추종) — backtestShort: roc<-d 돌파에 숏 진입 / roc>+d 반등에 커버 (SL/TP)
 *
 * 정직 기준: B는 A 대비 MDD/손실을 줄이는가(자본보존)? C는 하락장에서 +수익을 내는가?
 *           단일 심볼 한 케이스가 아니라 여러 심볼·타임프레임에서 일관돼야 신뢰.
 * 실행: npx tsx scripts/test-bear-strategies.ts
 */
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.QUANT_MCP_DATA_DIR = join(tmpdir(), `quant-mcp-bear-${process.pid}`);
const H = await import("../src/mcp-server/handlers.js");
const now = new Date();

// 공통 dip-buy leaf — roc(p)<-d 매수 / roc>+d 반등 청산, SL/TP는 leaf.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dipLeaf(symbol: string, p: number, d: number, sl: number, tp: number): any {
  return {
    id: "l", type: "leaf", name: "급락매수",
    strategy: {
      id: "s", userId: "u", name: `dip(roc${p}<-${d})`, description: "", symbol,
      rules: [
        { id: "b", action: "buy", conditions: [{ id: "cb", indicator: "roc", params: { period: p }, operator: "lt", value: -d }], quantityPercent: 10 },
        { id: "se", action: "sell", conditions: [{ id: "cs", indicator: "roc", params: { period: p }, operator: "gt", value: d }], quantityPercent: 100 },
      ],
      stopLossPercent: sl, takeProfitPercent: tp, isActive: true, createdAt: now, updatedAt: now,
    },
  };
}

// B. 레짐필터: dip leaf 를 condition 노드로 감싼다. trend_down 이면 thenNode 비활성(=신규 진입 없음 → 자본보존).
//    in = trend_down 을 뺀 화이트리스트. computeRegime 재사용(룩어헤드0, backtest≡live).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function regimeAvoidTree(symbol: string, p: number, d: number, sl: number, tp: number): any {
  return {
    id: "root", type: "condition", name: "하락추세 회피",
    condition: { type: "regime", in: ["trend_up", "range", "high_vol"] },
    thenNode: dipLeaf(symbol, p, d, sl, tp),
  };
}

// C. 숏 추세추종: sell=숏진입(급락 돌파), buy=커버(반등). short-engine 이 부호 미러.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function shortTree(symbol: string, p: number, d: number): any {
  return {
    id: "l", type: "leaf", name: "추세추종 숏",
    strategy: {
      id: "s", userId: "u", name: `short(roc${p})`, description: "", symbol,
      rules: [
        // sell = 숏 진입: roc<-d (하방 돌파, 추세 가담)
        { id: "se", action: "sell", conditions: [{ id: "cs", indicator: "roc", params: { period: p }, operator: "lt", value: -d }], quantityPercent: 100 },
        // buy = 커버: roc>+d (반등 → 숏 청산)
        { id: "b", action: "buy", conditions: [{ id: "cb", indicator: "roc", params: { period: p }, operator: "gt", value: d }], quantityPercent: 100 },
      ],
      isActive: true, createdAt: now, updatedAt: now,
    },
  };
}

// [interval, days(봉수), rocPeriod, dropPct, SL, TP]
const configs: [string, number, number, number, number, number][] = [
  ["1h", 2000, 4, 5, 3, 5],
  ["4h", 1500, 4, 8, 5, 8],
  ["1d", 730, 3, 5, 5, 8],
];
const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function row(tag: string, sym: string, r: any): string {
  if (!r || !r.ok) return `${tag.padEnd(20)} ${sym.padEnd(8)} ❌ ${r?.error ?? "예외"}`;
  const s = r.stats; const ret = Number(s.totalReturnPercent);
  const robust = r.verdict?.oosRobust;
  const robustTag = robust === true ? "✅" : robust === false ? "✗" : "—";
  return `${tag.padEnd(20)} ${sym.padEnd(8)} ${String(r.bars).padStart(5)} | ${String(ret).padStart(7)} ${String(s.maxDrawdownPercent).padStart(6)} ${String(s.totalTrades).padStart(4)} ${String(s.winRate).padStart(5)} ${String(s.sharpeRatio).padStart(6)} | ${robustTag}`;
}

async function main() {
  console.log("═══ 하락장 대응 전략 정직 비교 (옵션 B) ═══");
  console.log("실 Binance 데이터(최근=하락 구간 포함). 미화 없음. A=칼날잡기 / B=회피 / C=숏.\n");
  let aTot = 0, bTot = 0, cTot = 0, cWin = 0, bBeatsA = 0, n = 0;

  for (const [iv, days, p, d, sl, tp] of configs) {
    console.log(`── ${iv} / ${days}봉 / roc${p} ±${d}% / SL${sl} TP${tp} ──`);
    console.log("전략                 심볼     봉수  |  수익%   MDD%   거래 승률% Sharpe | OOS");
    console.log("─".repeat(84));
    for (const sym of symbols) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const a: any = await H.backtest({ tree: dipLeaf(sym, p, d, sl, tp), symbol: sym, interval: iv, days });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const b: any = await H.backtest({ tree: regimeAvoidTree(sym, p, d, sl, tp), symbol: sym, interval: iv, days });
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const c: any = await H.backtestShort({ tree: shortTree(sym, p, d), symbol: sym, interval: iv, days, risk: { stopLossPercent: sl, takeProfitPercent: tp } });
        console.log(row("A 칼날잡기(롱)", sym, a));
        console.log(row("B 회피(레짐필터)", sym, b));
        console.log(row("C 숏(추세추종)", sym, c));
        console.log("");
        if (a?.ok && b?.ok && c?.ok) {
          n++;
          aTot += Number(a.stats.totalReturnPercent);
          bTot += Number(b.stats.totalReturnPercent);
          cTot += Number(c.stats.totalReturnPercent);
          if (Number(c.stats.totalReturnPercent) > 0) cWin++;
          // B가 A보다 자본보존(수익 더 높거나 MDD 더 작음)
          if (Number(b.stats.totalReturnPercent) >= Number(a.stats.totalReturnPercent)) bBeatsA++;
        }
      } catch (e) {
        console.log(`${iv} ${sym}: 예외 ${e instanceof Error ? e.message : e}\n`);
      }
    }
  }

  console.log("═".repeat(84));
  if (n > 0) {
    console.log(`\n집계(${n}개 심볼·TF 케이스, 평균 수익%):`);
    console.log(`  A 칼날잡기(롱):   ${(aTot / n).toFixed(2)}%`);
    console.log(`  B 회피(레짐필터): ${(bTot / n).toFixed(2)}%   (A 이상 자본보존: ${bBeatsA}/${n})`);
    console.log(`  C 숏(추세추종):   ${(cTot / n).toFixed(2)}%   (+수익 케이스: ${cWin}/${n})`);
  }
  console.log("\n정직 결론 기준:");
  console.log("  · B가 A 대비 손실/MDD를 줄이면 → '하락장 회피'는 실효 있음(자본보존).");
  console.log("  · C가 다수 심볼에서 +수익이면 → '하락장 숏'이 방향성 정답. 일부만이면 노이즈.");
  console.log("  · 셋 다 신통찮으면 → 정직하게 '이 데이터/규칙으로는 하락장 알파 없음' 보고.");
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
