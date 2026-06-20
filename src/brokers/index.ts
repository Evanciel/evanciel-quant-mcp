/**
 * brokers/index.ts — 브로커 어댑터 팩토리. env BYOK 자격증명을 주입해 어댑터 인스턴스 생성.
 * 키 없으면 null(→ 페이퍼 유지). KIS는 BrokerType "hantoo"로 등록(types.ts 유니온).
 */
import { BinanceBrokerAdapter } from "./binance.js";
import { KisBrokerAdapter } from "./kis.js";
import { KiwoomBrokerAdapter } from "./kiwoom.js";
import { TossBrokerAdapter } from "./toss.js";
import { loadCredentials, type Broker, type Env } from "./safety.js";
import type { BrokerAdapter } from "./types.js";

export function getAdapter(broker: Broker, market: "spot" | "futures" = "spot"): { adapter: BrokerAdapter; env: Env } | null {
  const c = loadCredentials(broker, market);
  if (!c) return null;
  const env = c.env;
  if (broker === "binance") return { adapter: new BinanceBrokerAdapter(c), env };
  if (broker === "kis") return { adapter: new KisBrokerAdapter(c), env };
  if (broker === "kiwoom") return { adapter: new KiwoomBrokerAdapter(c), env };
  if (broker === "toss") return { adapter: new TossBrokerAdapter(c), env };
  return null;
}

/** 어떤 브로커가 어떤 env로 설정됐는지(키 노출 0). live_status 툴 + 가이드용. */
export function configuredBrokers(): { broker: Broker; market?: string; env: Env; live: boolean }[] {
  const out: { broker: Broker; market?: string; env: Env; live: boolean }[] = [];
  const masterOn = (process.env.LIVE_TRADING_ENABLED || "").trim() === "true";
  for (const [broker, market] of [["binance", "spot"], ["binance", "futures"], ["kis", undefined], ["kiwoom", undefined], ["toss", undefined]] as [Broker, ("spot" | "futures") | undefined][]) {
    const c = loadCredentials(broker, market ?? "spot");
    if (c) out.push({ broker, market, env: c.env, live: c.env === "live" && masterOn });
  }
  return out;
}
