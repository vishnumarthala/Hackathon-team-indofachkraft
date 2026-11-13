// Ticket 027 FR-2: request bodies and query strings of the messaging APIs. Safe to import anywhere.
import { z } from "zod";
import { isUuid } from "@/lib/cases/validation";
import { BODY_MAX, PAGE_LIMIT, PAGE_LIMIT_MAX, SUBJECT_MAX } from "./constants";

const uuid = (message: string) => z.string({ error: message }).refine(isUuid, { error: message });

const body = z
  .string({ error: "Write a message" })
  .refine((v) => v.trim().length > 0, { error: "Write a message" })
  .refine((v) => v.length <= BODY_MAX, { error: `Messages can be up to ${BODY_MAX} characters` });

const clientId = uuid("client_id must be a uuid");
const documentId = uuid("Choose a document").nullish().transform((v) => v ?? null);

export const ThreadCreateSchema = z.object({
  case_id: uuid("Choose who to message"),
  subject: z
    .string({ error: "Enter a subject" })
    .trim()
    .min(1, { error: "Enter a subject" })
    .max(SUBJECT_MAX, { error: `Subjects can be up to ${SUBJECT_MAX} characters` }),
  body,
  client_id: clientId,
  document_id: documentId,
});
export type ThreadCreateInput = z.output<typeof ThreadCreateSchema>;

export const MessageCreateSchema = z.object({ body, client_id: clientId, document_id: documentId });
export type MessageCreateInput = z.output<typeof MessageCreateSchema>;

export const ThreadListQuery = z.object({
  case_id: uuid("case_id must be a uuid").optional(),
  child_id: uuid("child_id must be a uuid").optional(),
});

export const MessagePageQuery = z.object({
  before: z.iso.datetime({ offset: true, error: "before must be an ISO date-time" }).optional(),
  limit: z.coerce
    .number({ error: "limit must be a number" })
    .int({ error: "limit must be a whole number" })
    .min(1, { error: "limit must be at least 1" })
    .max(PAGE_LIMIT_MAX, { error: `limit can be at most ${PAGE_LIMIT_MAX}` })
    .default(PAGE_LIMIT),
});

/** Query-string values as an object for zod (absent keys stay undefined). */
export function queryObject(url: string, keys: readonly string[]): Record<string, string | undefined> {
  const params = new URL(url).searchParams;
  return Object.fromEntries(keys.map((k) => [k, params.get(k) ?? undefined]));
}
