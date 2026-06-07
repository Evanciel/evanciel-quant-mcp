/**
 * 숏 백테스트 엔진 — Phase A(머니패스 0). 롱 엔진(engine.ts)의 신호평가(resolveActiveStrategy/evalLadderSignals)를
 * "재사용"하고 포지션 라이프사이클만 숏 순수코어(short.ts)로 처리 → 신호로직 복제 0 + backtest≡live 기반.
 *
 * 숏 의미 매핑(직관적): 전략의 'sell'(약세) 신호 = 숏 진입, 'buy'(강세) 신호 = 커버(청산).
 *   → jarvis는 평소 전략 트리를 작성하고 side:"short"만 주면 약세에 숏, 강세에 커버.
 * 정직: 숏 단독 alpha weak(리서치) → 레짐헤지/양방향/캐리 표현력. 알파 광고 금지.
 * Phase B(라이브 선물 어댑터)가 동일 evaluateShortTick 호출 → backtest≡live.
 */
import type { BacktestConfig, BacktestResult, BacktestTrade, StrategyNode } from "../types/strategy";
import { resolveActiveStrategy, evalLadderSignals } from "./engine";

// OHLCV는 engine.ts 로컬 타입과 동일(미export). multi.ts/optimizer.ts와 같은 패턴으로 로컬 정의.
interface OHLCV { date: string; open: number; high: number; low: number; close: number; volume: number }
import { calcMaxDrawdown, calcSharpeRatio } from "./metrics";
import { openShort, evaluateShortTick, computeShortPnl, type ShortPosition } from "../position/short";
import { floorQty } from "../position/qty";

export interface ShortRisk {
  stopLossPercent?: number | null;
  takeProfitPercent?: number | null;
  trailingStopPercent?: number | null;
  fundingRatePerInterval?: number | null; // 봉당 펀딩(숏 수취 모델). 미지정 시 0(펀딩 무시).
}

/**
 * 숏 전용 백테스트. side="short" 디렉셔널 봇. sell신호=숏진입, buy신호=커버. 노레버(notional=capital) Phase A.
 * 결과는 BacktestResult 호환(롱과 동일 지표). 청산가/펀딩은 short.ts가 처리.
 */
export function runShortBacktest(
  rootNode: StrategyNode,
  data: OHLCV[],
  config: BacktestConfig,
  risk?: ShortRisk
): BacktestResult {
  const prices = data.map((d) => d.close);
  const volumes = data.map((d) => d.volume);
  const highs = data.map((d) => d.high);
  const lows = data.map((d) => d.low);

  let balance = config.initialCapital;
  let pos: ShortPosition | null = null;
  const trades: BacktestTrade[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  const cache = new Map<string, number[]>();
  const comm = (config.commission ?? 0.1) / 100;
  const slip = (config.slippage ?? 0.05) / 100;
  const fundingRate = typeof risk?.fundingRatePerInterval === "number" ? risk.fundingRatePerInterval : null;

  for (let i = 0; i < data.length; i++) {
    const price = data[i].close;
    const active = resolveActiveStrategy(rootNode, data, i, prices, volumes);
    const sig = active ? evalLadderSignals(active, i, prices, volumes, highs, lows, cache) : { buyRule: null, sell: false };

    if (pos && pos.status === "open") {
      // 커버 신호 = buy 룰(강세). 펀딩 1봉 누적(숏 수취 모델).
      const r = evaluateShortTick(pos, price, {
        coverSignal: !!sig.buyRule,
        fundingRatePerInterval: fundingRate ?? undefined,
        intervalsElapsed: fundingRate != null ? 1 : 0,
      });
      if (r.exit) {
        const coverPrice = price * (1 + slip); // 되사기 = 슬리피지 불리(가격↑)
        const grossPnl = computeShortPnl(pos.entryAvg, coverPrice, pos.qty);
        const entryComm = pos.entryAvg * pos.qty * comm;
        const exitComm = coverPrice * pos.qty * comm;
        const net = grossPnl - entryComm - exitComm + r.next.fundingPnl;
        balance += net;
        trades.push({ date: data[i].date, action: "buy", price: coverPrice, quantity: pos.qty, pnl: net, balance });
        pos = null;
      } else {
        pos = r.next;
      }
    }

    if (!pos && sig.sell && !sig.buyRule) {
      // 약세 신호 → 숏 진입(노레버: notional=capital)
      const entryPrice = price * (1 - slip); // 숏 매도 = 슬리피지 불리(가격↓ 체결)
      const qty = floorQty(config.initialCapital / entryPrice);
      if (qty > 0) {
        pos = openShort({
          entryPrice, qty,
          stopLossPercent: risk?.stopLossPercent, takeProfitPercent: risk?.takeProfitPercent,
          trailingStopPercent: risk?.trailingStopPercent, openedAt: data[i].date,
        });
        trades.push({ date: data[i].date, action: "sell", price: entryPrice, quantity: qty, pnl: 0, balance });
      }
    }

    const unreal = pos ? computeShortPnl(pos.entryAvg, price, pos.qty) : 0;
    equityCurve.push({ date: data[i].date, value: balance + unreal });
  }

  const finalEquity = equityCurve[equityCurve.length - 1]?.value ?? config.initialCapital;
  const totalReturn = finalEquity - config.initialCapital;
  const totalReturnPercent = (totalReturn / config.initialCapital) * 100;

  // 숏 청산(커버=action "buy")의 pnl로 승률/PF 계산 (롱의 calcTradeStats는 sell=청산 가정이라 직접 계산)
  const covers = trades.filter((t) => t.action === "buy");
  const wins = covers.filter((t) => t.pnl > 0);
  const winRate = covers.length > 0 ? (wins.length / covers.length) * 100 : 0;
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(covers.filter((t) => t.pnl < 0).reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 9999 : 0;

  return {
    totalReturn, totalReturnPercent,
    maxDrawdown: calcMaxDrawdown(equityCurve, config.initialCapital),
    winRate, totalTrades: covers.length, profitFactor,
    sharpeRatio: calcSharpeRatio(equityCurve, config.timeframe),
    trades, equityCurve,
  };
}
