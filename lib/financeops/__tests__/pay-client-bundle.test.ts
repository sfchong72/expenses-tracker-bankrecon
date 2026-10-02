import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

/**
 * The Finance Operations screens are CLIENT components. Anything they import (directly or transitively) ships to the
 * browser, so it must not touch Node built-ins, server secrets or the server-only parsers. (A build caught this once:
 * a screen imported the statement parser, which needs node:crypto and node:zlib.)
 */
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..", "..", "..");

function resolveImport(from: string, spec: string): string | null {
  let base: string;
  if (spec.startsWith("@/")) base = join(ROOT, spec.slice(2));
  else if (spec.startsWith(".")) base = resolve(dirname(from), spec);
  else return null;
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx")]) {
    if (existsSync(candidate) && !readdirSafe(candidate)) return candidate;
  }
  return null;
}
const readdirSafe = (p: string): boolean => { try { readdirSync(p); return true; } catch { return false; } };

function closure(entry: string): Map<string, string> {
  const seen = new Map<string, string>();
  const stack = [entry];
  while (stack.length) {
    const file = stack.pop() as string;
    if (seen.has(file)) continue;
    const code = readFileSync(file, "utf8");
    seen.set(file, code);
    // value imports only: `import type` is erased by the compiler
    for (const m of code.matchAll(/^\s*(?:import|export)\s+(?!type\b)[^;]*?\sfrom\s+["']([^"']+)["']/gm)) {
      const next = resolveImport(file, m[1]);
      if (next) stack.push(next);
    }
  }
  return seen;
}

describe("client bundles for the Finance Operations screens stay free of Node-only code", () => {
  const screens = readdirSync(join(ROOT, "app")).filter((f) => /^finance-ops-.*\.tsx$/.test(f) || f === "finance-intake-workspace.tsx" || f === "intake-review.tsx");

  it("finds the screens", () => assert.ok(screens.length >= 5, screens.join()));

  for (const screen of screens) {
    it(`${screen}: no node: built-ins, no server-only module, no service-role key anywhere in its import tree`, () => {
      const files = closure(join(ROOT, "app", screen));
      for (const [file, code] of files) {
        const rel = file.slice(ROOT.length + 1).replace(/\\/g, "/");
        assert.equal(/from\s+["']node:/.test(code) || /require\(["']node:/.test(code), false, `${rel} imports a Node built-in`);
        assert.equal(/service[_-]?role|SERVICE_ROLE|FINANCEOPS_DB_USER|FINANCEOPS_HMAC/.test(code.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, "")), false, `${rel} names a server secret`);
        assert.equal(/lib\/financeops\/(db-session|persist|store-supabase|route-support|payments\/(bank-import|register-import|services|http|persist|handler|store-supabase|db))["']/.test(code), false, `${rel} imports a server-only FinanceOps module`);
      }
    });
  }
});
