// Usage: node scripts/dev/check-env-usage.mjs <VAR> <allowed paths...> -> "server only" or offenders.
import { readFileSync } from "node:fs";
import { listFiles } from "./files.mjs";

const [name, ...allowed] = process.argv.slice(2);
if (!name) {
  console.error("usage: node scripts/dev/check-env-usage.mjs <VAR> <allowed paths...>");
  process.exit(2);
}
const norm = (p) => p.replace(/\\/g, "/").replace(/\/+$/, "");
const allowedPaths = allowed.map(norm);
const isAllowed = (file) => allowedPaths.some((a) => file === a || file.startsWith(`${a}/`));
const offenders = listFiles(["app", "components", "lib"], [".ts", ".tsx", ".js", ".jsx", ".mjs"]).filter(
  (file) => !isAllowed(file) && readFileSync(file, "utf8").includes(name),
);
console.log(offenders.length ? offenders.join("\n") : "server only");
process.exit(offenders.length ? 1 : 0);
