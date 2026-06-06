/**
 * store/db.ts — 로컬 단일소유자 스토어 (node:sqlite 내장, 네이티브 의존성 0).
 * Supabase(bots/composite_strategies/trades/bot_logs/position_state) 대체. RLS·user_id·cron_lock 없음.
 * DB 파일: env QUANT_MCP_DATA_DIR || ~/.quant-mcp/store.db
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type BotMode = "paper" | "live";
export type BotStatus = "running" | "stopped" | "error";

export interface CompositeRow {
  id: string; name: string; root_node: unknown; symbol: string;
  market: "spot" | "futures"; leverage: number;
  stop_loss_percent: number | null; take_profit_percent: number | null;
  tp_ladder: unknown | null; scale_in: unknown | null; pyramid: unknown | null;
  trailing_stop_percent: number | null; created_at: string;
}
export interface BotRow {
  id: string; name: string; symbol: string; composite_strategy_id: string;
  status: BotStatus; mode: BotMode; capital: number; broker: string;
  interval_seconds: number; position_state: unknown | null;
  last_evaluated_at: string | null; last_executed_at: string | null; created_at: string;
}
export interface TradeRow {
  id: string; bot_id: string; ts: string; side: string; price: number; qty: number;
  pnl: number; is_paper: number; reason: string; idempotency_key: string;
}
export interface LogRow { id: string; bot_id: string; ts: string; action: string; detail: string; }

let _db: DatabaseSync | null = null;

export function dataDir(): string {
  return process.env.QUANT_MCP_DATA_DIR || join(homedir(), ".quant-mcp");
}

export function db(): DatabaseSync {
  if (_db) return _db;
  const dir = dataDir();
  mkdirSync(dir, { recursive: true });
  const d = new DatabaseSync(join(dir, "store.db"));
  d.exec(`
    CREATE TABLE IF NOT EXISTS composite_strategies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_node TEXT NOT NULL, symbol TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'spot', leverage REAL NOT NULL DEFAULT 1,
      stop_loss_percent REAL, take_profit_percent REAL,
      tp_ladder TEXT, scale_in TEXT, pyramid TEXT, trailing_stop_percent REAL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS bots (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, symbol TEXT NOT NULL,
      composite_strategy_id TEXT NOT NULL REFERENCES composite_strategies(id),
      status TEXT NOT NULL DEFAULT 'stopped', mode TEXT NOT NULL DEFAULT 'paper',
      capital REAL NOT NULL DEFAULT 1000000, broker TEXT NOT NULL DEFAULT 'binance',
      interval_seconds INTEGER NOT NULL DEFAULT 60, position_state TEXT,
      last_evaluated_at TEXT, last_executed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, ts TEXT NOT NULL, side TEXT NOT NULL,
      price REAL NOT NULL, qty REAL NOT NULL, pnl REAL NOT NULL DEFAULT 0,
      is_paper INTEGER NOT NULL DEFAULT 1, reason TEXT NOT NULL DEFAULT '',
      idempotency_key TEXT NOT NULL UNIQUE
    );
    CREATE TABLE IF NOT EXISTS bot_logs (
      id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, ts TEXT NOT NULL, action TEXT NOT NULL, detail TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_trades_bot ON trades(bot_id, ts);
    CREATE INDEX IF NOT EXISTS idx_logs_bot ON bot_logs(bot_id, ts);
  `);
  _db = d;
  return d;
}

const now = () => new Date().toISOString();
const J = (v: unknown) => (v == null ? null : JSON.stringify(v));
const P = <T,>(v: unknown): T | null => (v == null ? null : JSON.parse(v as string) as T);

// ── composite_strategies ──
export function insertComposite(c: Omit<CompositeRow, "id" | "created_at"> & { id?: string }): CompositeRow {
  const id = c.id ?? randomUUID();
  const created_at = now();
  db().prepare(`INSERT INTO composite_strategies (id,name,root_node,symbol,market,leverage,stop_loss_percent,take_profit_percent,tp_ladder,scale_in,pyramid,trailing_stop_percent,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, c.name, JSON.stringify(c.root_node), c.symbol, c.market, c.leverage,
    c.stop_loss_percent, c.take_profit_percent, J(c.tp_ladder), J(c.scale_in), J(c.pyramid), c.trailing_stop_percent, created_at);
  return { ...c, id, created_at };
}
export function getComposite(id: string): CompositeRow | null {
  const r = db().prepare(`SELECT * FROM composite_strategies WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { ...r, root_node: JSON.parse(r.root_node as string), tp_ladder: P(r.tp_ladder), scale_in: P(r.scale_in), pyramid: P(r.pyramid) } as CompositeRow;
}

// ── bots ──
export function insertBot(b: Omit<BotRow, "id" | "created_at" | "status" | "position_state" | "last_evaluated_at" | "last_executed_at"> & { id?: string; status?: BotStatus }): BotRow {
  const id = b.id ?? randomUUID();
  const created_at = now();
  const status = b.status ?? "stopped";
  db().prepare(`INSERT INTO bots (id,name,symbol,composite_strategy_id,status,mode,capital,broker,interval_seconds,position_state,last_evaluated_at,last_executed_at,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, b.name, b.symbol, b.composite_strategy_id, status, b.mode, b.capital, b.broker, b.interval_seconds, null, null, null, created_at);
  return { ...b, id, status, position_state: null, last_evaluated_at: null, last_executed_at: null, created_at };
}
function mapBot(r: Record<string, unknown>): BotRow {
  return { ...r, position_state: P(r.position_state) } as BotRow;
}
export function getBot(id: string): BotRow | null {
  const r = db().prepare(`SELECT * FROM bots WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  return r ? mapBot(r) : null;
}
export function listBots(): BotRow[] {
  return (db().prepare(`SELECT * FROM bots ORDER BY created_at DESC`).all() as Record<string, unknown>[]).map(mapBot);
}
export function listRunningBots(): BotRow[] {
  return (db().prepare(`SELECT * FROM bots WHERE status='running'`).all() as Record<string, unknown>[]).map(mapBot);
}
export function setBotStatus(id: string, status: BotStatus): void {
  db().prepare(`UPDATE bots SET status=? WHERE id=?`).run(status, id);
}
export function setBotPositionState(id: string, ps: unknown, evaluatedAt = true, executed = false): void {
  const t = now();
  db().prepare(`UPDATE bots SET position_state=?, last_evaluated_at=?${executed ? ", last_executed_at=?" : ""} WHERE id=?`)
    .run(...(executed ? [J(ps), evaluatedAt ? t : null, t, id] : [J(ps), evaluatedAt ? t : null, id]));
}

// ── trades / logs ──
export function isDuplicateTrade(idempotencyKey: string): boolean {
  return !!db().prepare(`SELECT 1 FROM trades WHERE idempotency_key=?`).get(idempotencyKey);
}
export function insertTrade(t: Omit<TradeRow, "id" | "ts">): TradeRow | null {
  if (isDuplicateTrade(t.idempotency_key)) return null;
  const id = randomUUID(); const ts = now();
  db().prepare(`INSERT INTO trades (id,bot_id,ts,side,price,qty,pnl,is_paper,reason,idempotency_key) VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(id, t.bot_id, ts, t.side, t.price, t.qty, t.pnl, t.is_paper, t.reason, t.idempotency_key);
  return { ...t, id, ts };
}
export function insertLog(bot_id: string, action: string, detail = ""): void {
  db().prepare(`INSERT INTO bot_logs (id,bot_id,ts,action,detail) VALUES (?,?,?,?,?)`).run(randomUUID(), bot_id, now(), action, detail);
}
/** 봇의 누적 거래 통계(실현손익=청산 pnl 합, 청산 수, 승리 수). 대시보드 표시용. */
export function tradeStats(bot_id: string): { realizedPnl: number; closes: number; wins: number } {
  const r = db().prepare(`SELECT COALESCE(SUM(pnl),0) p, COUNT(*) c, COALESCE(SUM(CASE WHEN pnl>0 THEN 1 ELSE 0 END),0) w FROM trades WHERE bot_id=? AND side='sell'`).get(bot_id) as { p: number; c: number; w: number };
  return { realizedPnl: r.p, closes: r.c, wins: r.w };
}
export function recentTrades(bot_id: string, limit = 50): TradeRow[] {
  return db().prepare(`SELECT * FROM trades WHERE bot_id=? ORDER BY ts DESC LIMIT ?`).all(bot_id, limit) as unknown as TradeRow[];
}
export function recentLogs(bot_id: string, limit = 50): LogRow[] {
  return db().prepare(`SELECT * FROM bot_logs WHERE bot_id=? ORDER BY ts DESC LIMIT ?`).all(bot_id, limit) as unknown as LogRow[];
}
