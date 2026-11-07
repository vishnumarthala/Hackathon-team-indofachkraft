// Usage: node scripts/dev/check-copy.mjs <paths...> -> "clean" or offending lines.
import { readFileSync } from "node:fs";
import { listFiles } from "./files.mjs";

const roots = process.argv.slice(2);
if (!roots.length) {
  console.error("usage: node scripts/dev/check-copy.mjs <paths...>");
  process.exit(2);
}
const offenders = [];
for (const file of listFiles(roots, [".ts", ".tsx", ".md"])) {
  readFileSync(file, "utf8")
    .split(/\r?\n/)
    .forEach((line, i) => {
      const diagnosis = /diagnos/i.test(line) && !/not a diagnosis/i.test(line);
      if (diagnosis || /HIPAA compliant/i.test(line) || /fee per referral/i.test(line)) {
        offenders.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
}
console.log(offenders.length ? offenders.join("\n") : "clean");
process.exit(offenders.length ? 1 : 0);
