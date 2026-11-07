// Turns on the repo's git hooks (.githooks/pre-push blocks pushes to main). Never fails npm install.
import { execFileSync } from "node:child_process";

try {
  const inside = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], { stdio: ["ignore", "pipe", "ignore"] })
    .toString()
    .trim();
  if (inside === "true") execFileSync("git", ["config", "core.hooksPath", ".githooks"], { stdio: "ignore" });
} catch {
  // Not a git checkout (CI tarball, Docker build): nothing to do.
}
