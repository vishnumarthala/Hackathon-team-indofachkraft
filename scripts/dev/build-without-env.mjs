// Runs `npm run build` with .env.local moved aside, then always restores it.
import { spawnSync } from "node:child_process";
import { existsSync, renameSync } from "node:fs";

const ENV = ".env.local";
const BACKUP = ".env.local.bak-build";
const moved = existsSync(ENV);
if (moved) renameSync(ENV, BACKUP);
let code = 1;
try {
  const result = spawnSync("npm run build", { stdio: "inherit", shell: true });
  code = result.status ?? 1;
} finally {
  if (moved) renameSync(BACKUP, ENV);
}
process.exit(code);
