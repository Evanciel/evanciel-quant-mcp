/**
 * market-data.ts — 대시보드 패널용 읽기 전용 데이터 (마켓 오버뷰 / 포트폴리오 분석 / 스캐너).
 * 전부 Binance 공개 데이터(키 불필요) + 로컬 스토어. 비용 큰 호출은 TTL 캐시(레이트리밋 보호).
 * 정직: 스크리닝/레짐은 후보 생성·맥락 제공이지 알파 보장이 아니다.
 */
import { fetch24hrTickers, fetchKlines, type Ticker24h } from "../data/binance-public.js";
import { computeRegime, type RegimeLabel } from "../core/backtest/regime.js";
import { rankUniverse, type RankMetric } from "../core/scanner/rank.js";
import { getAdapter } from "../brokers/index.js";
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

// ── 한국 주식(키움) 패널 — 메인 주식 위주 모드 ──
// 키움은 거래량상위 API가 없어 고정 대형주 유니버스를 일봉으로 랭킹. 키 필요(키움 mock/실계정) + 장중/장후 모두 일봉은 조회 가능.
// 키움 mock은 rate-limit(429)가 있어 throttle + 캐시(일봉=10분)로 보호. 개별 실패는 스킵(부분 표시).
export const KR_UNIVERSE: [string, string][] = [
  ["005930", "삼성전자"], ["000660", "SK하이닉스"], ["373220", "LG에너지솔루션"], ["207940", "삼성바이오로직스"], ["005380", "현대차"],
  ["000270", "기아"], ["068270", "셀트리온"], ["035420", "NAVER"], ["035720", "카카오"], ["005490", "POSCO홀딩스"],
  ["105560", "KB금융"], ["055550", "신한지주"], ["051910", "LG화학"], ["006400", "삼성SDI"], ["012330", "현대모비스"],
];
type KrBar = { date: string; datetime?: string; open: number; high: number; low: number; close: number; volume?: number };
const krSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const _krCandleCache = new Map<string, { at: number; bars: KrBar[] }>();
const _krInflight = new Map<string, Promise<KrBar[]>>();   // in-flight 합치기: 동시 동일코드 요청을 단일 Promise로(중복 업스트림/429 폭주 방지)
const _krLastGood = new Map<string, KrBar[]>();             // 직전 성공 일봉(무TTL): 일시적 429에도 유니버스 구성 종목 안정화(stale 폴백)
const KR_CANDLE_TTL = 600_000; // 일봉 10분
async function krDaily(code: string): Promise<KrBar[]> {
  const c = _krCandleCache.get(code);
  if (c && Date.now() - c.at < KR_CANDLE_TTL) return c.bars;
  const inflight = _krInflight.get(code);
  if (inflight) return inflight; // 진행 중 동일코드 요청에 합류 → 콜드스타트/TTL만료 동시호출 중복 제거
  const p = (async () => {
    const ad = getAdapter("kiwoom", "spot")?.adapter as { getCandles?: (s: string, i: string, n: number) => Promise<KrBar[]> } | undefined;
    if (!ad?.getCandles) throw new Error("키움 미설정(키 필요)");
    const bars = await ad.getCandles(code, "1d", 60);
    _krCandleCache.set(code, { at: Date.now(), bars });
    return bars;
  })();
  _krInflight.set(code, p);
  try { return await p; } finally { _krInflight.delete(code); }
}
async function krUniverseData(): Promise<{ code: string; name: string; bars: KrBar[] }[]> {
  const out: { code: string; name: string; bars: KrBar[] }[] = [];
  for (const [code, name] of KR_UNIVERSE) {
    const cached = _krCandleCache.get(code);
    const hit = cached && Date.now() - cached.at < KR_CANDLE_TTL;
    let bars: KrBar[] | null = null;
    try { bars = await krDaily(code); }
    catch { bars = _krLastGood.get(code) ?? null; /* 429/개별실패 → 직전 성공값 폴백(없으면 스킵). 구성 종목 churn 방지 */ }
    if (bars && bars.length >= 2) { _krLastGood.set(code, bars); out.push({ code, name, bars }); }
    if (!hit) await krSleep(150); // 실제 호출했을 때만 throttle(429 회피)
  }
  return out;
}

export interface KrTickerView { symbol: string; name: string; price: number; changePct: number; value: number; broker: "kiwoom" }
function krView(u: { code: string; name: string; bars: KrBar[] }): KrTickerView {
  const n = u.bars.length, last = u.bars[n - 1], prev = u.bars[n - 2];
  const pc = prev && prev.close > 0 ? ((last.close - prev.close) / prev.close) * 100 : 0;
  return { symbol: u.code, name: u.name, price: last.close, changePct: +pc.toFixed(2), value: last.close * (last.volume || 0), broker: "kiwoom" };
}
let _krOvCache: { at: number; ov: unknown } | null = null;
export async function krMarketOverview(): Promise<{ majors: KrTickerView[]; topVolume: KrTickerView[]; regime: MarketOverview["regime"]; market: "kr"; at: number }> {
  if (_krOvCache && Date.now() - _krOvCache.at < 30_000) return _krOvCache.ov as never;
  const uni = await krUniverseData();
  const views = uni.map(krView);
  const majors = views.slice(0, 5);
  const topVolume = [...views].sort((a, b) => b.value - a.value).slice(0, 5);
  let regime: MarketOverview["regime"] = null;
  const sec = uni.find((u) => u.code === "005930");
  if (sec && sec.bars.length >= 60) { const r = computeRegime(sec.bars.map((b) => b.close), sec.bars.map((b) => b.high), sec.bars.map((b) => b.low)); regime = { label: r.label, direction: r.direction, confidence: r.confidence, adx: r.adx, atrPct: r.atrPct }; }
  const ov = { majors, topVolume, regime, market: "kr" as const, at: Date.now() };
  _krOvCache = { at: Date.now(), ov };
  return ov;
}

export interface KrScanRow { symbol: string; name: string; score: number; price: number; changePct: number; broker: "kiwoom" }
const _krScanCache = new Map<string, { at: number; rows: KrScanRow[] }>();
export async function krScan(metric: RankMetric, top = 8): Promise<KrScanRow[]> {
  const key = `${metric}:${top}`;
  const c = _krScanCache.get(key);
  if (c && Date.now() - c.at < 60_000) return c.rows;
  const uni = await krUniverseData();
  const entries = uni.map((u) => ({ symbol: u.code, bars: u.bars.map((b) => ({ open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 })) }));
  const ranked = rankUniverse(entries, metric, top, "desc", 14);
  const byCode = new Map(uni.map((u) => [u.code, u]));
  const rows: KrScanRow[] = ranked.map((r) => {
    const u = byCode.get(r.symbol)!; const n = u.bars.length, last = u.bars[n - 1], prev = u.bars[n - 2];
    return { symbol: r.symbol, name: u.name, score: +r.score.toFixed(2), price: last.close, changePct: prev && prev.close > 0 ? +(((last.close - prev.close) / prev.close) * 100).toFixed(2) : 0, broker: "kiwoom" as const };
  });
  _krScanCache.set(key, { at: Date.now(), rows });
  return rows;
}
