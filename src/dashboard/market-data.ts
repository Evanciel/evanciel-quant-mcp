/**
 * market-data.ts — 대시보드 패널용 읽기 전용 데이터 (마켓 오버뷰 / 포트폴리오 분석 / 스캐너).
 * 전부 Binance 공개 데이터(키 불필요) + 로컬 스토어. 비용 큰 호출은 TTL 캐시(레이트리밋 보호).
 * 정직: 스크리닝/레짐은 후보 생성·맥락 제공이지 알파 보장이 아니다.
 */
import { fetch24hrTickers, fetchKlines, type Ticker24h } from "../data/binance-public.js";
import { computeRegime, type RegimeLabel } from "../core/backtest/regime.js";
import { rankUniverse, type RankMetric } from "../core/scanner/rank.js";
import * as store from "../store/db.js";

const MAJORS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT"];
// 거래대금 랭킹에서 제외할 스테이블/래핑 페어(USDT 마켓의 스테이블↔스테이블 등 노이즈).
const STABLE_RE = /^(USDC|FDUSD|TUSD|BUSD|DAI|USDP|EUR|AEUR|USD1)USDT$/;

export interface MarketTickerView { symbol: string; price: number; changePct: number; quoteVolume: number; high: number; low: number }
export interface MarketOverview {
  majors: MarketTickerView[];
  topVolume: MarketTickerView[];
  regime: { label: RegimeLabel; direction: string; confidence: number; adx: number; atrPct: number } | null;
  at: number;
}

const view = (t: Ticker24h): MarketTickerView => ({ symbol: t.symbol, price: t.lastPrice, changePct: t.priceChangePercent, quoteVolume: t.quoteVolume, high: t.highPrice, low: t.lowPrice });

let _regimeCache: { at: number; r: MarketOverview["regime"] } | null = null;
const REGIME_TTL = 300_000; // 5분
async function btcRegime(): Promise<MarketOverview["regime"]> {
  if (_regimeCache && Date.now() - _regimeCache.at < REGIME_TTL) return _regimeCache.r;
  try {
    const bars = await fetchKlines("BTCUSDT", "1d", 220);
    if (bars.length < 60) return null;
    const r = computeRegime(bars.map((b) => b.close), bars.map((b) => b.high), bars.map((b) => b.low));
    const out = { label: r.label, direction: r.direction, confidence: r.confidence, adx: r.adx, atrPct: r.atrPct };
    _regimeCache = { at: Date.now(), r: out };
    return out;
  } catch { return _regimeCache?.r ?? null; }
}

let _ovCache: { at: number; ov: MarketOverview } | null = null;
const OV_TTL = 15_000;
export async function marketOverview(): Promise<MarketOverview> {
  if (_ovCache && Date.now() - _ovCache.at < OV_TTL) return _ovCache.ov;
  const tickers = await fetch24hrTickers();
  const bySym = new Map(tickers.map((t) => [t.symbol, t]));
  const majors = MAJORS.map((s) => bySym.get(s)).filter((t): t is Ticker24h => !!t).map(view);
  const topVolume = tickers
    .filter((t) => t.symbol.endsWith("USDT") && !STABLE_RE.test(t.symbol) && Number.isFinite(t.quoteVolume))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, 5)
    .map(view);
  const regime = await btcRegime();
  const ov: MarketOverview = { majors, topVolume, regime, at: Date.now() };
  _ovCache = { at: Date.now(), ov };
  return ov;
}

// ── 포트폴리오 분석 (로컬 스토어, 네트워크 없음) ──
export interface BotPerf { id: string; name: string; symbol: string; mode: string; running: boolean; realizedPnl: number; closes: number; wins: number; winRate: number }
export interface PortfolioAnalytics {
  curve: { t: number; cum: number }[];   // 누적 실현손익 시계열(체결 시점순)
  perBot: BotPerf[];
  totals: { realized: number; closes: number; wins: number; winRate: number; bots: number; running: number };
}
export function portfolioAnalytics(bots: { id: string; name: string; symbol: string; mode: string; status?: string }[]): PortfolioAnalytics {
  // 누적 실현손익 곡선: 전 봇 체결을 시간 오름차순으로 누적(청산 시 pnl 기록).
  const trades = store.listTradesAll(1000).slice().sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : 0));
  let cum = 0;
  const curve: { t: number; cum: number }[] = [];
  for (const tr of trades) {
    if (!tr.pnl) continue; // 진입(pnl=0)은 곡선에 점 안 찍음 — 청산 실현만
    cum += tr.pnl;
    curve.push({ t: Math.floor(Date.parse(tr.ts) / 1000), cum: +cum.toFixed(2) });
  }
  const perBot: BotPerf[] = bots.map((b) => {
    const s = store.tradeStats(b.id);
    return { id: b.id, name: b.name, symbol: b.symbol, mode: b.mode, running: b.status === "running", realizedPnl: +s.realizedPnl.toFixed(2), closes: s.closes, wins: s.wins, winRate: s.closes > 0 ? Math.round((s.wins / s.closes) * 100) : 0 };
  }).sort((a, b) => b.realizedPnl - a.realizedPnl);
  const realized = perBot.reduce((a, b) => a + b.realizedPnl, 0);
  const closes = perBot.reduce((a, b) => a + b.closes, 0);
  const wins = perBot.reduce((a, b) => a + b.wins, 0);
  return { curve, perBot, totals: { realized: +realized.toFixed(2), closes, wins, winRate: closes > 0 ? Math.round((wins / closes) * 100) : 0, bots: bots.length, running: perBot.filter((p) => p.running).length } };
}

// ── 스캐너 (유니버스 = 거래대금 상위 USDT 페어, 일봉 메트릭 랭킹) ──
export interface ScanResult { symbol: string; score: number; price: number; changePct: number; quoteVolume: number }
const UNIVERSE_SIZE = 18;
const _scanCache = new Map<string, { at: number; rows: ScanResult[] }>();
const SCAN_TTL = 60_000;
export async function scanUniverse(metric: RankMetric, top = 8): Promise<ScanResult[]> {
  const key = `${metric}:${top}`;
  const c = _scanCache.get(key);
  if (c && Date.now() - c.at < SCAN_TTL) return c.rows;
  const tickers = await fetch24hrTickers();
  const universe = tickers
    .filter((t) => t.symbol.endsWith("USDT") && !STABLE_RE.test(t.symbol))
    .sort((a, b) => b.quoteVolume - a.quoteVolume)
    .slice(0, UNIVERSE_SIZE);
  const bySym = new Map(universe.map((t) => [t.symbol, t]));
  // 일봉 30개씩 — 병렬 페치(캐시가 있어 1분에 1회만 실제 호출).
  const entries = await Promise.all(universe.map(async (t) => {
    try { const bars = await fetchKlines(t.symbol, "1d", 30); return { symbol: t.symbol, bars }; }
    catch { return null; }
  }));
  const ranked = rankUniverse(entries.filter((e): e is { symbol: string; bars: Awaited<ReturnType<typeof fetchKlines>> } => !!e), metric, top, "desc", 14);
  const rows: ScanResult[] = ranked.map((r) => {
    const t = bySym.get(r.symbol);
    return { symbol: r.symbol, score: +r.score.toFixed(2), price: t?.lastPrice ?? 0, changePct: t?.priceChangePercent ?? 0, quoteVolume: t?.quoteVolume ?? 0 };
  });
  _scanCache.set(key, { at: Date.now(), rows });
  return rows;
}
