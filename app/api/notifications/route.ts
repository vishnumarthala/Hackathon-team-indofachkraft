import { getAuthenticatedUser } from "@/lib/auth";
import { fail, ok } from "@/lib/http";
import { decodeCursor, listInbox } from "@/lib/notify/inbox";

export const dynamic = "force-dynamic";

// FR-7: the signed-in user's own in-app notifications, newest first.
export async function GET(req: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const raw = new URL(req.url).searchParams.get("cursor");
  const cursor = decodeCursor(raw);
  if (raw && !cursor) return fail(400, "Invalid request", { cursor: "Invalid cursor" });
  return ok(await listInbox(user.id, cursor));
}
