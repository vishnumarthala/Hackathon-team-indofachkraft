import { z } from "zod";
import { getAuthenticatedUser } from "@/lib/auth";
import { fail, ok, parseJson } from "@/lib/http";
import { markRead, unreadCount } from "@/lib/notify/inbox";

export const dynamic = "force-dynamic";

const schema = z.union([
  z.object({ ids: z.array(z.uuid()).min(1).max(100) }).strict(),
  z.object({ all: z.literal(true) }).strict(),
]);

// FR-7: marks the caller's own rows read. Ids that belong to someone else match nothing (no error, no leak).
export async function POST(req: Request) {
  const user = await getAuthenticatedUser();
  if (!user) return fail(401, "Authentication required");
  const parsed = await parseJson(req, schema);
  if ("response" in parsed) return parsed.response;
  const updated = await markRead(user.id, "all" in parsed.data ? { all: true } : { ids: parsed.data.ids });
  return ok({ updated, unread: await unreadCount(user.id) });
}
