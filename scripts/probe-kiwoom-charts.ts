/**
 * probe-kiwoom-charts.ts — 키움 모의 차트 API(분/주/월봉) 응답 구조 탐침 + 실잔고 확인.
 *   추측 대신 실서버 응답키를 보고 getCandles 라우팅을 정확히 구현하려는 1회용 프로브. 읽기전용.
 * 실행: npx tsx scripts/probe-kiwoom-charts.ts (KIWOOM_ENV=mock + 키 .env.local 필요)
 */
import { readFileSync } from "node:fs";
for (const line of readFileSync(".env.local", "utf8").split(/\r?\n/)) { const m = line.match(/^([A-Z0-9_]+)=(.*)$/); if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); }
if ((process.env.KIWOOM_ENV || "mock") !== "mock") { console.error("❌ KIWOOM_ENV=mock 아님"); process.exit(1); }
const { getAdapter } = await import("../src/brokers/index.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const got = getAdapter("kiwoom", "spot");
if (!got) { console.error("키움 어댑터 없음(키 확인)"); process.exit(1); }
// private post는 런타임엔 접근 가능(TS private는 컴파일타임만).
const a = got.adapter as unknown as { getBalance: () => Promise<unknown>; post: (p: string, id: string, b: Record<string, unknown>) => Promise<{ data: Record<string, unknown> }> };
const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");

console.log("=== 실잔고(getBalance) ===");
try { console.log(JSON.stringify(await a.getBalance())); } catch (e) { console.log("ERR", e instanceof Error ? e.message : e); }
await sleep(3000);

const probes: [string, string, Record<string, unknown>][] = [
  ["분봉 ka10080 (tic_scope=5)", "ka10080", { stk_cd: "005930", tic_scope: "5", upd_stkpc_tp: "1" }],
  ["주봉 ka10082", "ka10082", { stk_cd: "005930", base_dt: today, upd_stkpc_tp: "1" }],
  ["월봉 ka10083", "ka10083", { stk_cd: "005930", base_dt: today, upd_stkpc_tp: "1" }],
];
for (const [label, id, body] of probes) {
  console.log(`\n=== ${label} ===`);
  try {
    const { data } = await a.post("/api/dostk/chart", id, body);
    const arrKey = Object.keys(data).find((k) => Array.isArray((data as Record<string, unknown>)[k]));
    const arr = arrKey ? (data[arrKey] as Record<string, unknown>[]) : [];
    console.log("return_code:", data.return_code, "| return_msg:", data.return_msg);
    console.log("arrayKey:", arrKey, "| len:", arr.length);
    if (arr[0]) console.log("row0 keys:", Object.keys(arr[0]).join(",")), console.log("row0:", JSON.stringify(arr[0]));
  } catch (e) { console.log("ERR", e instanceof Error ? e.message : e); }
  await sleep(3500);
}
process.exit(0);
