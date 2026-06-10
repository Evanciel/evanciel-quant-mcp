/**
 * release-hygiene.test.ts — 출시 위생 회귀 가드(코드 로직 0, 메타/문서 정합만).
 *
 * 목적: README의 "N tools"/"N개" 카운트, stderr 배너, CI node 버전, package.json
 * 메타가 실제 코드/설정과 어긋나는 드리프트를 빌드에서 잡는다(과거 22 vs 25 발산 재발 방지).
 * 진실의 원천 = 실제 등록된 MCP 툴 수(서버를 띄워 listTools로 카운트). 정규식으로 소스를
 * 긁지 않고 런타임 카운트를 기준선으로 삼는다.
 */
import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/mcp-server/index.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(ROOT, rel), "utf8");

/** 실제 등록된 MCP 툴 수 = 진실의 원천. */
async function actualToolCount(): Promise<number> {
  const server = buildServer();
  const [clientT, serverT] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "hygiene-client", version: "0.0.0" });
  await Promise.all([server.connect(serverT), client.connect(clientT)]);
  const tools = await client.listTools();
  await client.close();
  await server.close();
  return tools.tools.length;
}

describe("release hygiene — docs/meta ↔ code parity", () => {
  it("README EN/KO tool count matches the actual registered tool count", async () => {
    const n = await actualToolCount();

    for (const f of ["README.md", "README.ko.md"]) {
      const md = read(f);
      // EN: "(25 tools)" / KO: "(25개)" — 본문/헤더/TOC 어디서든 등장하는 카운트 토큰.
      const enHits = [...md.matchAll(/\((\d+)\s+tools\)/g)].map((m) => Number(m[1]));
      const koHits = [...md.matchAll(/\((\d+)개\)/g)].map((m) => Number(m[1]));
      const hits = [...enHits, ...koHits];
      expect(hits.length, `${f}: no "(N tools)"/"(N개)" count token found`).toBeGreaterThan(0);
      for (const h of hits) {
        expect(h, `${f}: stale tool count ${h} != actual ${n}`).toBe(n);
      }
    }
  });

  it("README EN/KO live-trading category subtotals sum to the actual tool count", async () => {
    const n = await actualToolCount();
    for (const f of ["README.md", "README.ko.md"]) {
      const md = read(f);
      // "### ... (8)" 식 카테고리 소계의 합 = 전체 툴 수.
      const subtotals = [...md.matchAll(/^###\s.*\((\d+)\)\s*$/gm)].map((m) => Number(m[1]));
      expect(subtotals.length, `${f}: category subtotals not found`).toBeGreaterThanOrEqual(2);
      const sum = subtotals.reduce((a, b) => a + b, 0);
      expect(sum, `${f}: category subtotals ${subtotals.join("+")} != actual ${n}`).toBe(n);
    }
  });

  it("stderr ready banner count matches the actual tool count", async () => {
    const n = await actualToolCount();
    const src = read("src/mcp-server/index.ts");
    const m = src.match(/server ready \(stdio\) — (\d+) tools/);
    expect(m, "index.ts: ready banner string not found").toBeTruthy();
    expect(Number(m![1]), `index.ts banner ${m![1]} != actual ${n}`).toBe(n);
  });

  it("CI node-version matches package.json engines.node (major)", () => {
    const pkg = JSON.parse(read("package.json")) as { engines?: { node?: string } };
    const engineMajor = (pkg.engines?.node ?? "").match(/(\d+)/)?.[1];
    expect(engineMajor, "package.json engines.node missing").toBeTruthy();

    const ci = read(".github/workflows/ci.yml");
    const ciNode = ci.match(/node-version:\s*([\d.]+)/)?.[1];
    expect(ciNode, "ci.yml node-version missing").toBeTruthy();
    const ciMajor = ciNode!.split(".")[0];
    expect(ciMajor, `ci node ${ciMajor} != engines major ${engineMajor}`).toBe(engineMajor);
  });

  it("package.json exposes a clean publish surface (exports, bin, files whitelist)", () => {
    const pkg = JSON.parse(read("package.json")) as {
      exports?: Record<string, unknown>;
      bin?: Record<string, string>;
      main?: string;
      files?: string[];
    };
    // exports 필드 존재 + 메인 진입점 정합.
    expect(pkg.exports?.["."], "exports['.'] missing").toBe("./dist/index.js");
    expect(pkg.main).toBe("dist/index.js");
    expect(pkg.bin?.["quant-mcp"]).toBe("dist/index.js");
    // files 화이트리스트가 dist를 포함(패키지 페이로드 누락 방지).
    expect(pkg.files ?? [], "files must whitelist dist").toContain("dist");
    // src/test는 화이트리스트에 들어가면 안 됨(소스 누출 방지).
    expect(pkg.files ?? []).not.toContain("src");
    expect(pkg.files ?? []).not.toContain("test");
  });

  it("ship-hygiene meta docs exist (CONTRIBUTING / CHANGELOG / SECURITY / LICENSE)", () => {
    for (const f of ["CONTRIBUTING.md", "CHANGELOG.md", "SECURITY.md", "LICENSE", ".npmignore"]) {
      expect(read(f).length, `${f} missing or empty`).toBeGreaterThan(0);
    }
  });
});
