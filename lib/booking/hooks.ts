// Extension points for later tickets, called by POST /api/appointments/hold before the SQL hold.
//   * 037 (Google Meet): video appointments need a signed-in guardian with a Google account -> return
//     `{ status: 403, error, code: "google_account_required" }` for `service.mode === "video"`.
//   * 042 (Hyderabad seed / demo safeguard): holds on demo profiles (`profile.is_synthetic`) need an explicit
//     acknowledgement (`demo_ack` in the body, add it to HoldSchema) and mark the appointment `is_demo`.
// Keep checks here (not in the route) so the voice agent (034) gets the same rules.
import type { BookableProfile, ServiceRow } from "./store";

export type HoldPreconditionContext = {
  profile: BookableProfile;
  service: ServiceRow;
  /** Signed-in guardian, or null for an anonymous (session-owned) hold. */
  userId: string | null;
  body: Record<string, unknown>;
};

export type HoldPreconditionFailure = { status: number; error: string; code: string };

export async function checkHoldPreconditions(ctx: HoldPreconditionContext): Promise<HoldPreconditionFailure | null> {
  void ctx;
  return null;
}
