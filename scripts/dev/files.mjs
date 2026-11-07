import { readdirSync, statSync } from "node:fs";
import path from "node:path";

const SKIP = new Set(["node_modules", ".next", ".git", ".tmp", "coverage"]);

export function listFiles(roots, extensions) {
  const out = [];
  const walk = (p) => {
    let st;
    try {
      st = statSync(p);
    } catch {
      return;
    }
    if (st.isDirectory()) {
      if (SKIP.has(path.basename(p))) return;
      for (const name of readdirSync(p)) walk(path.join(p, name));
    } else if (extensions.includes(path.extname(p))) {
      out.push(p.split(path.sep).join("/"));
    }
  };
  for (const root of roots) walk(root);
  return out.sort();
}
