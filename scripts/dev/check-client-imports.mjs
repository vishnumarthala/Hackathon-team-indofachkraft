// Prints client components ("use client") that read server env vars or import server-only modules.
import { readFileSync } from "node:fs";
import { listFiles } from "./files.mjs";

const SERVER_MODULES = ["@/lib/db", "@/lib/env", "@/lib/gemini", "@/lib/email", "@/lib/audit"];

function isClient(source) {
  const body = source.replace(/^\uFEFF/, "").replace(/^(\s|\/\/[^\n]*\n|\/\*[\s\S]*?\*\/)*/, "");
  return /^["']use client["']/.test(body);
}

const offenders = [];
for (const file of listFiles(["app", "components", "lib"], [".ts", ".tsx", ".js", ".jsx"])) {
  const source = readFileSync(file, "utf8");
  if (!isClient(source)) continue;
  const envVars = [...source.matchAll(/process\.env\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const badEnv = envVars.filter((v) => !v.startsWith("NEXT_PUBLIC_"));
  const imports = [...source.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
  const badImports = imports.filter((i) => SERVER_MODULES.includes(i));
  if (badEnv.length || badImports.length) offenders.push(`${file}: ${[...badEnv, ...badImports].join(", ")}`);
}
console.log(offenders.length ? offenders.join("\n") : "clean");
process.exit(offenders.length ? 1 : 0);
