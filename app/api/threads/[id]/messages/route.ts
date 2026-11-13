import { fail, fieldErrors, ok, parseJson } from "@/lib/http";
import { requireThreadAccess } from "@/lib/messaging/access";
import { MessageCreateSchema, MessagePageQuery, queryObject } from "@/lib/messaging/schemas";
import { listMessages, sendMessage } from "@/lib/messaging/store";

export const dynamic = "force-dynamic";

// 027 FR-2: one page of messages (oldest -> newest), `before` pages back. Re-checks access on every call, so a
// revoked guardian link / assignment / membership gets 404 on the next poll.
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireThreadAccess(id);
  if (gate instanceof Response) return gate;
  const query = MessagePageQuery.safeParse(queryObject(req.url, ["before", "limit"]));
  if (!query.success) return fail(400, "Invalid request", fieldErrors(query.error));
  const page = await listMessages(gate.thread, gate.user.id, query.data);
  const res = ok(page);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

// 027 FR-2/FR-3: send a message (idempotent per client_id; 30 per 5 minutes; archived -> 409; attachments must be
// readable by every participant -> else 422). The outbox event is written in the same transaction.
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireThreadAccess(id);
  if (gate instanceof Response) return gate;
  const parsed = await parseJson(req, MessageCreateSchema);
  if ("response" in parsed) return parsed.response;
  const result = await sendMessage(gate.thread, gate.user.id, parsed.data);
  if (!result.ok) return fail(result.status, result.error);
  return ok({ message: result.data.message }, result.data.created ? 201 : 200);
}
