/**
 * store/db.ts — 로컬 단일소유자 스토어 (node:sqlite 내장, 네이티브 의존성 0).
 * Supabase(bots/composite_strategies/trades/bot_logs/position_state) 대체. RLS·user_id·cron_lock 없음.
 * DB 파일: env QUANT_MCP_DATA_DIR || ~/.quant-mcp/store.db
 */
import { DatabaseSync } from "node:sqlite";
import { homedir } from "node:os";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export type BotMode = "paper" | "live";
export type BotStatus = "running" | "stopped" | "error";

export interface CompositeRow {
  id: string; name: string; root_node: unknown; symbol: string;
  market: "spot" | "futures"; leverage: number;
  stop_loss_percent: number | null; take_profit_percent: number | null;
  tp_ladder: unknown | null; scale_in: unknown | null; pyramid: unknown | null;
  trailing_stop_percent: number | null; risk_sizing: unknown | null; created_at: string;
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
  // 내구성/동시성(audit P1-21): WAL=크래시 시 마지막 커밋까지 보존+읽기 비차단, NORMAL=WAL과 조합 시 안전한 fsync 수준.
  d.exec(`PRAGMA journal_mode=WAL;`);
  d.exec(`PRAGMA synchronous=NORMAL;`);
  d.exec(`
    CREATE TABLE IF NOT EXISTS composite_strategies (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, root_node TEXT NOT NULL, symbol TEXT NOT NULL,
      market TEXT NOT NULL DEFAULT 'spot', leverage REAL NOT NULL DEFAULT 1,
      stop_loss_percent REAL, take_profit_percent REAL,
      tp_ladder TEXT, scale_in TEXT, pyramid TEXT, trailing_stop_percent REAL,
      risk_sizing TEXT,
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
  // 기존 DB용 멱등 마이그레이션(additive). node:sqlite는 중복 컬럼에 throw → try/catch가 멱등.
  try { d.exec(`ALTER TABLE composite_strategies ADD COLUMN risk_sizing TEXT`); } catch { /* 이미 존재 */ }
  _db = d;
  return d;
}

/**
 * 동기 트랜잭션 래퍼(audit P1-21). 체결 기록(insertTrade)과 장부(setBotPositionState)처럼 함께 살거나 함께
 * 죽어야 하는 쓰기를 원자화 — 사이 크래시로 '체결은 기록됐는데 장부는 없음'(P0-1 발산 갭) 방지.
 * ⚠️ fn은 동기만(await 금지 — tx를 이벤트루프에 걸쳐 잡으면 다른 쓰기 차단). 중첩 호출 금지(BEGIN 중복 throw).
 */
export function tx<T>(fn: () => T): T {
  const d = db();
  d.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    d.exec("COMMIT");
    return r;
  } catch (e) {
    try { d.exec("ROLLBACK"); } catch { /* 롤백 불가(연결 종료 등) — 원 에러를 우선 전파 */ }
    throw e;
  }
}

/**
 * 주기 백업(audit P1-21). VACUUM INTO로 일관 스냅샷을 backups/에 생성, 최근 keep개만 유지.
 * 실패는 throw하지 않고 null(백업 실패가 거래를 멈추면 안 됨 — 단 침묵 금지, console로 고지).
 */
export function backupDb(keep = 7): string | null {
  try {
    const dir = join(dataDir(), "backups");
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const dest = join(dir, `store-${stamp}.db`);
    db().exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`);
    const files = readdirSync(dir).filter((f) => /^store-.*\.db$/.test(f)).sort();
    for (const f of files.slice(0, Math.max(0, files.length - keep))) rmSync(join(dir, f), { force: true });
    return dest;
  } catch (e) {
    console.error(`[store] 백업 실패(거래는 계속): ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

const now = () => new Date().toISOString();
const J = (v: unknown) => (v == null ? null : JSON.stringify(v));
const P = <T,>(v: unknown): T | null => (v == null ? null : JSON.parse(v as string) as T);

// ── composite_strategies ──
export function insertComposite(c: Omit<CompositeRow, "id" | "created_at" | "risk_sizing"> & { id?: string; risk_sizing?: unknown | null }): CompositeRow {
  const id = c.id ?? randomUUID();
  const created_at = now();
  const risk_sizing = c.risk_sizing ?? null; // additive opt-in: 미지정 봇은 null(=legacy 사이징)
  db().prepare(`INSERT INTO composite_strategies (id,name,root_node,symbol,market,leverage,stop_loss_percent,take_profit_percent,tp_ladder,scale_in,pyramid,trailing_stop_percent,risk_sizing,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, c.name, JSON.stringify(c.root_node), c.symbol, c.market, c.leverage,
    c.stop_loss_percent, c.take_profit_percent, J(c.tp_ladder), J(c.scale_in), J(c.pyramid), c.trailing_stop_percent, J(risk_sizing), created_at);
  return { ...c, id, created_at, risk_sizing };
}
export function getComposite(id: string): CompositeRow | null {
  const r = db().prepare(`SELECT * FROM composite_strategies WHERE id=?`).get(id) as Record<string, unknown> | undefined;
  if (!r) return null;
  return { ...r, root_node: JSON.parse(r.root_node as string), tp_ladder: P(r.tp_ladder), scale_in: P(r.scale_in), pyramid: P(r.pyramid), risk_sizing: P(r.risk_sizing) } as CompositeRow;
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

/**
 * 봇의 라이브 체결 장부상 미청산 수량/가중평단(audit P0-1 기동 시드 근거).
 * is_paper=0 거래를 시간순으로 걸어 buy=적립 / sell=평단 기준 차감. 음수 방지(과매도 기록은 0으로 캡).
 * 용도: 재시작 시 position_state=null인데 이 값>0이면 '체결됐는데 장부가 유실된 크래시 갭' 시그니처 —
 * 거래소 보유를 봇에 귀속(채택)해도 되는 근거가 된다(근거 없는 수동 보유 입양 금지, fail-closed).
 */
export function liveOpenLedger(bot_id: string): { qty: number; avgPrice: number } {
  // 동일 ts(같은 ms) 다건은 rowid(삽입 순서)로 안정 정렬 — id(랜덤 UUID) 정렬은 buy/sell 순서를 뒤섞는다.
  const rows = db().prepare(`SELECT side, price, qty FROM trades WHERE bot_id=? AND is_paper=0 ORDER BY ts, rowid`)
    .all(bot_id) as { side: string; price: number; qty: number }[];
  let qty = 0, cost = 0;
  for (const r of rows) {
    if (!(r.qty > 0)) continue;
    if (r.side === "buy") { qty += r.qty; cost += r.qty * r.price; }
    else if (r.side === "sell") {
      const avg = qty > 1e-12 ? cost / qty : 0;
      const q = Math.min(r.qty, qty);
      cost -= q * avg;
      qty -= q;
    }
  }
  return qty > 1e-12 ? { qty, avgPrice: cost / qty } : { qty: 0, avgPrice: 0 };
}

/**
 * 포트폴리오 실현손익 곡선 요약(전 봇 합산, 시간순). 포트폴리오 레벨 캡(MDD 디리스킹)의 peak 자기자본 도출용.
 *  - realized = Σpnl(전 거래, 청산 시 기록) → 현재까지 실현손익.
 *  - peakCum  = 실현손익 누적곡선의 고점(prefix-sum 최댓값, 음수면 0). base+peakCum = peak equity.
 * 영속 peak 컬럼 없이 거래이력에서 결정적으로 도출(스키마 변경 0). 미실현은 포함 안 함(라이브 마크 신뢰원 부재 → 보수적).
 */
export function realizedEquityCurve(): { realized: number; peakCum: number } {
  try {
    const total = db().prepare(`SELECT COALESCE(SUM(pnl),0) s FROM trades`).get() as { s: number } | undefined;
    // 누적합의 최댓값(고점). 거래 0건이면 peak 0.
    const peak = db().prepare(
      `SELECT COALESCE(MAX(cum),0) p FROM (SELECT SUM(pnl) OVER (ORDER BY ts, rowid) AS cum FROM trades)` /* rowid=삽입 순서(동일 ms 안정 정렬) */
    ).get() as { p: number } | undefined;
    return { realized: total?.s ?? 0, peakCum: Math.max(0, peak?.p ?? 0) };
  } catch { return { realized: 0, peakCum: 0 }; }
}
