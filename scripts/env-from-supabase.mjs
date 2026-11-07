// Writes the local Supabase URL/keys/DB URL into .env.local (creating it from .env.example if missing).
import { execSync } from "node:child_process";
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

let status;
try {
  status = execSync("npx supabase status -o env", { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
} catch {
  console.error("Supabase is not running - run: npx supabase start");
  process.exit(1);
}

const values = {};
for (const line of status.split(/\r?\n/)) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m) values[m[1]] = m[2].trim().replace(/^"(.*)"$/, "$1");
}

// Newer CLI versions also print PUBLISHABLE_KEY / SECRET_KEY; the legacy JWT keys are preferred.
const wanted = {
  NEXT_PUBLIC_SUPABASE_URL: values.API_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: values.ANON_KEY ?? values.PUBLISHABLE_KEY,
  SUPABASE_SERVICE_ROLE_KEY: values.SERVICE_ROLE_KEY ?? values.SECRET_KEY,
  DATABASE_URL: values.DB_URL,
};
const missing = Object.entries(wanted).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
  console.error(`Supabase status did not include values for: ${missing.join(", ")}`);
  process.exit(1);
}

if (!existsSync(".env.local")) copyFileSync(".env.example", ".env.local");
const lines = readFileSync(".env.local", "utf8").split(/\r?\n/);
for (const [name, value] of Object.entries(wanted)) {
  const i = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (i >= 0) lines[i] = `${name}=${value}`;
  else {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${name}=${value}`, "");
  }
}
writeFileSync(".env.local", lines.join("\n"));
console.log("wrote 4 Supabase values to .env.local");
