// In-memory limits for the landing page's live voice demo, which spends ElevenLabs credits.
// Per server instance only: enough to stop casual repeat clicks, not a hard quota.
export const PER_IP_LIMIT = 3;
export const PER_IP_WINDOW_MS = 10 * 60_000;
export const GLOBAL_LIMIT = 30;
export const GLOBAL_WINDOW_MS = 60 * 60_000;

const byIp = new Map<string, number[]>();
let global: number[] = [];

const recent = (times: number[], now: number, windowMs: number) => times.filter((t) => now - t < windowMs);

export function allowVoiceDemo(ip: string, now = Date.now()): boolean {
  global = recent(global, now, GLOBAL_WINDOW_MS);
  const mine = recent(byIp.get(ip) ?? [], now, PER_IP_WINDOW_MS);
  if (mine.length >= PER_IP_LIMIT || global.length >= GLOBAL_LIMIT) {
    byIp.set(ip, mine);
    return false;
  }
  mine.push(now);
  global.push(now);
  byIp.set(ip, mine);
  return true;
}

export function resetVoiceDemoLimits(): void {
  byIp.clear();
  global = [];
}
