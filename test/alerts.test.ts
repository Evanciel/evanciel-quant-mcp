/**
 * alerts.test.ts — 알림 엔진 순수 검증(detectAlerts/Debouncer/AlertBuffer).
 */
import { describe, it, expect } from "vitest";
import { detectAlerts, Debouncer, AlertBuffer, type BotAlertView } from "../src/core/alerts/alerts.js";

const bot = (over: Partial<BotAlertView>): BotAlertView => ({
  id: "1", name: "테스트봇", symbol: "BTCUSDT", status: "running", closes: 0, realizedPnl: 0, openCount: 0, ...over,
});
const ISO = "2026-06-09T00:00:00Z";

describe("detectAlerts", () => {
  it("첫 틱(prev=null)은 기준선만, 알림 0", () => {
    expect(detectAlerts(null, [bot({})], 1000, ISO)).toEqual([]);
  });

  it("변화 없으면 알림 0", () => {
    const prev = [bot({})];
    expect(detectAlerts(prev, [bot({})], 1000, ISO)).toEqual([]);
  });

  it("running→error = critical bot_error", () => {
    const out = detectAlerts([bot({ status: "running" })], [bot({ status: "error" })], 1000, ISO);
    expect(out).toHaveLength(1);
    expect(out[0].level).toBe("critical");
    expect(out[0].kind).toBe("bot_error");
  });

  it("running→stopped = warn bot_stopped", () => {
    const out = detectAlerts([bot({ status: "running" })], [bot({ status: "stopped" })], 1000, ISO);
    expect(out[0].level).toBe("warn");
    expect(out[0].kind).toBe("bot_stopped");
  });

  it("stopped→running = info bot_started", () => {
    const out = detectAlerts([bot({ status: "stopped" })], [bot({ status: "running" })], 1000, ISO);
    expect(out[0].kind).toBe("bot_started");
  });

  it("청산 증가(손실) = warn trade_closed, 손익 표기", () => {
    const out = detectAlerts([bot({ closes: 2, realizedPnl: 100 })], [bot({ closes: 3, realizedPnl: 80 })], 1000, ISO);
    const tc = out.find((e) => e.kind === "trade_closed")!;
    expect(tc.level).toBe("warn");
    expect(tc.message).toContain("-20");
  });

  it("청산 증가(이익) = info trade_closed", () => {
    const out = detectAlerts([bot({ closes: 0, realizedPnl: 0 })], [bot({ closes: 1, realizedPnl: 50 })], 1000, ISO);
    const tc = out.find((e) => e.kind === "trade_closed")!;
    expect(tc.level).toBe("info");
    expect(tc.message).toContain("+50");
  });

  it("포지션 진입/전량청산 감지", () => {
    const open = detectAlerts([bot({ openCount: 0 })], [bot({ openCount: 1 })], 1000, ISO);
    expect(open.some((e) => e.kind === "position_opened")).toBe(true);
    const close = detectAlerts([bot({ openCount: 1 })], [bot({ openCount: 0 })], 1000, ISO);
    expect(close.some((e) => e.kind === "position_closed")).toBe(true);
  });

  it("신규 봇은 기준선만(비교 안 함)", () => {
    const out = detectAlerts([bot({ id: "1" })], [bot({ id: "1" }), bot({ id: "2", status: "error" })], 1000, ISO);
    expect(out).toEqual([]); // id:2는 prev에 없음 → 다음 틱부터
  });

  it("id는 고유(같은 틱 다중 이벤트)", () => {
    const out = detectAlerts(
      [bot({ id: "1", status: "running" })],
      [bot({ id: "1", status: "error", closes: 1, realizedPnl: -5 })],
      1000, ISO,
    );
    const ids = new Set(out.map((e) => e.id));
    expect(ids.size).toBe(out.length);
  });
});

describe("Debouncer", () => {
  it("TTL 내 중복 억제, 만료 후 재허용", () => {
    const d = new Debouncer();
    expect(d.shouldSend("bot_error:1", 0, 1000)).toBe(true);
    expect(d.shouldSend("bot_error:1", 500, 1000)).toBe(false); // TTL 내
    expect(d.shouldSend("bot_error:1", 1001, 1000)).toBe(true); // 만료
  });

  it("다른 key는 독립", () => {
    const d = new Debouncer();
    expect(d.shouldSend("a", 0, 1000)).toBe(true);
    expect(d.shouldSend("b", 0, 1000)).toBe(true);
  });

  it("sweep로 만료분 제거 → Map 무한증식 방지", () => {
    const d = new Debouncer();
    for (let i = 0; i < 100; i++) d.shouldSend(`k${i}`, 0, 1000);
    expect(d.size).toBe(100);
    d.sweep(2000); // 전부 만료
    expect(d.size).toBe(0);
  });
});

describe("AlertBuffer", () => {
  it("최신순 recent 반환", () => {
    const b = new AlertBuffer();
    b.push({ id: "1", ts: ISO, level: "info", kind: "x", message: "a" });
    b.push({ id: "2", ts: ISO, level: "info", kind: "x", message: "b" });
    expect(b.recent(10).map((e) => e.id)).toEqual(["2", "1"]);
  });

  it("cap 초과 시 오래된 것부터 폐기", () => {
    const b = new AlertBuffer(3);
    for (let i = 0; i < 5; i++) b.push({ id: String(i), ts: ISO, level: "info", kind: "x", message: "m" });
    expect(b.size).toBe(3);
    expect(b.recent(10).map((e) => e.id)).toEqual(["4", "3", "2"]);
  });
});
