// Local outbox worker (ticket 032 FR-4): the same pass as POST /api/cron/outbox, every 10 s.
// Usage: npm run -s outbox:run [-- --once] [--interval 10] [--duration 60] [--mock-log <file>]
//   --mock-log <file>  local testing only: email/WhatsApp deliveries are not sent; each one appends
//                      "<channel> <notification id>" to <file> (used to prove exactly-once sending, eval E-5).
import { loadEnvConfig } from "@next/env";
import { appendFileSync } from "node:fs";

loadEnvConfig(process.cwd(), false, { info: () => {}, error: console.error });

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const once = process.argv.includes("--once");
  const intervalMs = Number(arg("interval") ?? 10) * 1000;
  const durationMs = arg("duration") ? Number(arg("duration")) * 1000 : Infinity;
  const mockLog = arg("mock-log");
  if (mockLog && process.env.NODE_ENV === "production") throw new Error("--mock-log is for local testing only");

  const { pg } = await import("../lib/pg");
  const { runOutbox } = await import("../lib/notify/worker");
  // 031: the payment refund job runs in the same local loop (Vercel: /api/cron/payments).
  const { runPaymentJobs } = await import("../lib/payments/jobs");
  // 045: fee jobs (balance links, fee refunds, offer / package expiry, reminders).
  const { runFeeJobs } = await import("../lib/fees/jobs");
  type Senders = NonNullable<Parameters<typeof runOutbox>[0]>["senders"];

  const senders: Senders = mockLog
    ? {
        email: async ({ notification }) => {
          await sleep(Math.random() * 20);
          appendFileSync(mockLog, `email ${notification.id}\n`);
          return { status: "sent", providerMessageId: "mock" };
        },
        whatsapp: async ({ notification }) => {
          await sleep(Math.random() * 20);
          appendFileSync(mockLog, `whatsapp ${notification.id}\n`);
          return { status: "sent", providerMessageId: "mock" };
        },
      }
    : undefined;

  const sql = await pg();
  const started = Date.now();
  let stop = false;
  process.on("SIGINT", () => (stop = true));
  process.on("SIGTERM", () => (stop = true));
  try {
    for (;;) {
      const result = await runOutbox({ sql, senders, timeBudgetMs: 5_000 });
      const payments = await runPaymentJobs({ sql });
      const fees = await runFeeJobs({ sql });
      console.log(JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...result, payments, fees }));
      if (once || stop || Date.now() - started + intervalMs > durationMs) break;
      await sleep(intervalMs);
      if (stop) break;
    }
  } finally {
    await sql.end({ timeout: 5 });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
