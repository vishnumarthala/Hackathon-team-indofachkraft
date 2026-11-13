// Extension points for later tickets, called by the booking routes before the SQL state machine.
//   * 037 (Google Meet, FR-5a): holding or confirming a `video` appointment needs a signed-in guardian with a linked
//     Google identity (019 `linkIdentity`): 422 `Link your Google account to book a video consultation`
//     (`google_account_required`). In-clinic services are unaffected.
//   * 042 (Hyderabad seed / demo safeguard): holds on demo profiles (`profile.is_synthetic`) need an explicit
//     acknowledgement (`demo_ack` in the body, add it to HoldSchema) and mark the appointment `is_demo`.
// Keep checks here (not in the route) so the voice agent (034) gets the same rules: call checkHoldPreconditions()
// before `holdSlot` and checkConfirmPreconditions() before `confirmHold`.
import { GOOGLE_ACCOUNT_REQUIRED, hasGoogleIdentity } from "@/lib/google/meet";
import type { BookableProfile, ServiceRow } from "./store";

export type HoldPreconditionContext = {
  profile: BookableProfile;
  service: ServiceRow;
  /** Signed-in guardian, or null for an anonymous (session-owned) hold. */
  userId: string | null;
  body: Record<string, unknown>;
};

export type HoldPreconditionFailure = { status: number; error: string; code: string };

const GOOGLE_REQUIRED: HoldPreconditionFailure = { status: 422, error: GOOGLE_ACCOUNT_REQUIRED, code: "google_account_required" };

/** FR-5a: video needs a Google identity (anonymous visitors cannot have one yet: they sign in with Google first). */
async function videoNeedsGoogle(mode: string | null | undefined, userId: string | null): Promise<HoldPreconditionFailure | null> {
  if (mode !== "video") return null;
  if (userId && (await hasGoogleIdentity(userId))) return null;
  return GOOGLE_REQUIRED;
}

export async function checkHoldPreconditions(ctx: HoldPreconditionContext): Promise<HoldPreconditionFailure | null> {
  return videoNeedsGoogle(ctx.service.mode, ctx.userId);
}

/** Before confirming a hold the caller owns (`mode` from the hold's service snapshot). */
export async function checkConfirmPreconditions(ctx: { mode: string | null | undefined; userId: string }): Promise<HoldPreconditionFailure | null> {
  return videoNeedsGoogle(ctx.mode, ctx.userId);
}
