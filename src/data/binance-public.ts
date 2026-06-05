/**
 * binance-public.ts — Binance 공개 REST 데이터(키 불필요). v1의 유일한 데이터 출처.
 * stock-autotrade/scripts/agent-cli.ts 의 fetchKlines 페이지네이션을 그대로 이식(verbatim).
 */
export interface Bar { date: string; open: number; high: number; low: number; close: number; volume: number }

const MAX_KLINE_PAGES = 60; // 60 × 1000 = 60,000봉 상한(1m≈41일).

export const mapKline = (k: (string | number)[]): Bar => ({
  date: new Date(Number(k[0])).toISOString().slice(0, 10),
  open: parseFloat(k[1] as string), high: parseFloat(k[2] as string),
  low: parseFloat(k[3] as string), close: parseFloat(k[4] as string), volume: parseFloat(k[5] as string),
});

export async function fetchKlinePage(symbol: string, interval: string, limit: number, endTime?: number): Promise<(string | number)[][]> {
  const u = new URL("https://api.binance.com/api/v3/klines");
  u.searchParams.set("symbol", symbol);
  u.searchParams.set("interval", interval);
  u.searchParams.set("limit", String(Math.min(1000, Math.max(20, limit))));
  if (endTime !== undefined) u.searchParams.set("endTime", String(endTime));
  const res = await fetch(u, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`klines ${res.status} (symbol=${symbol})`);
  return (await res.json()) as (string | number)[][];
}

/**
 * limit<=1000 → 단일 요청. limit>1000 → endTime을 과거로 당기며 페이지네이션(인트라데이 충분한 봉수).
 * 페이지 경계 중복 제거(openTime) + 시간순 정렬 + 최신 want개 절단. 이 로직이 틀리면 인트라데이 백테스트가
 * 조용히 잘려 모든 OOS 게이트가 약해진다(load-bearing).
 */
export async function fetchKlines(symbol: string, interval: string, limit: number): Promise<Bar[]> {
  const want = Math.max(20, limit);
  if (want <= 1000) return (await fetchKlinePage(symbol, interval, want)).map(mapKline);

  const all: (string | number)[][] = [];
  let endTime: number | undefined = undefined;
  for (let page = 0; page < MAX_KLINE_PAGES && all.length < want; page++) {
    const raw = await fetchKlinePage(symbol, interval, 1000, endTime);
    if (raw.length === 0) break;
    all.push(...raw);
    const oldestOpen = Number(raw[0][0]);
    if (!Number.isFinite(oldestOpen)) break;
    endTime = oldestOpen - 1;
    if (raw.length < 1000) break;
  }
  const seen = new Set<number>();
  const sorted = all
    .filter((k) => { const t = Number(k[0]); if (seen.has(t)) return false; seen.add(t); return true; })
    .sort((a, b) => Number(a[0]) - Number(b[0]));
  return sorted.slice(-want).map(mapKline);
}

/** summarizeDerivatives 입력 형태(core/signals/derivatives.ts 와 구조 일치). 데이터 레이어는 core를 import하지 않음. */
export interface DerivativesInput {
  symbol: string;
  fundingRate?: number;
  intervalHours: number;
  fundingHistory?: number[];
  oiNow?: number; oiThen?: number;
  priceNow?: number; priceThen?: number;
  topPositionRatio?: number;
  retailAccountRatio?: number;
  takerBuySellRatio?: number;
}

/**
 * Binance fapi 파생 데이터 페치(펀딩/OI/롱숏). 지역차단/레이트리밋 시 부분 degrade(null).
 * /futures/data/* 는 ~30일만 보존(소급 백필 불가).
 */
export async function fetchDerivatives(symbol: string, period: string, lookback: number): Promise<{ input: DerivativesInput; nextFundingTime: number | null }> {
  const fjson = async (url: string): Promise<unknown> => {
    try { const r = await fetch(url, { signal: AbortSignal.timeout(10000) }); if (!r.ok) return null; return await r.json(); }
    catch { return null; }
  };
  const FAPI = "https://fapi.binance.com";
  const [fundingHist, premium, fundingInfo, oiHist, topLS, retailLS, takerLS, klines] = await Promise.all([
    fjson(`${FAPI}/fapi/v1/fundingRate?symbol=${symbol}&limit=100`),
    fjson(`${FAPI}/fapi/v1/premiumIndex?symbol=${symbol}`),
    fjson(`${FAPI}/fapi/v1/fundingInfo`),
    fjson(`${FAPI}/futures/data/openInterestHist?symbol=${symbol}&period=${period}&limit=${lookback}`),
    fjson(`${FAPI}/futures/data/topLongShortPositionRatio?symbol=${symbol}&period=${period}&limit=1`),
    fjson(`${FAPI}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=${period}&limit=1`),
    fjson(`${FAPI}/futures/data/takerlongshortRatio?symbol=${symbol}&period=${period}&limit=1`),
    fetchKlines(symbol, period, lookback + 1).catch(() => [] as Bar[]),
  ]);
  type FR = { fundingRate: string }; type OI = { sumOpenInterestValue: string };
  type FI = { symbol: string; fundingIntervalHours: number };
  const fundingHistory = Array.isArray(fundingHist) ? (fundingHist as FR[]).map((x) => parseFloat(x.fundingRate)).filter((n) => Number.isFinite(n)) : undefined;
  const fundingRate = premium && typeof (premium as { lastFundingRate?: string }).lastFundingRate === "string"
    ? parseFloat((premium as { lastFundingRate: string }).lastFundingRate) : fundingHistory?.[fundingHistory.length - 1];
  const fi = Array.isArray(fundingInfo) ? (fundingInfo as FI[]).find((x) => x.symbol === symbol) : null;
  const intervalHours = fi?.fundingIntervalHours ?? 8;
  const oiArr = Array.isArray(oiHist) ? (oiHist as OI[]).map((x) => parseFloat(x.sumOpenInterestValue)) : [];
  const oiNow = oiArr.length ? oiArr[oiArr.length - 1] : undefined;
  const oiThen = oiArr.length ? oiArr[0] : undefined;
  const kl = klines as Bar[];
  const priceNow = kl.length ? kl[kl.length - 1].close : undefined;
  const priceThen = kl.length ? kl[0].close : undefined;
  const num = (v: unknown, k: string) => Array.isArray(v) && v[0] && typeof (v[0] as Record<string, string>)[k] === "string" ? parseFloat((v[0] as Record<string, string>)[k]) : undefined;
  return {
    input: {
      symbol, fundingRate, intervalHours, fundingHistory, oiNow, oiThen, priceNow, priceThen,
      topPositionRatio: num(topLS, "longShortRatio"),
      retailAccountRatio: num(retailLS, "longShortRatio"),
      takerBuySellRatio: num(takerLS, "buySellRatio"),
    },
    nextFundingTime: (premium as { nextFundingTime?: number } | null)?.nextFundingTime ?? null,
  };
}
