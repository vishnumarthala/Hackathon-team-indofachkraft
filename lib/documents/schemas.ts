// Ticket 023 FR-3: request bodies of the document APIs. Safe to import anywhere.
import { z } from "zod";
import { isUuid } from "@/lib/cases/validation";
import { cleanFileName, DOCUMENT_CATEGORIES } from "./constants";

const uuid = (message: string) => z.string({ error: message }).refine(isUuid, { error: message });

const uploadBase = {
  title: z
    .string({ error: "Enter a title" })
    .trim()
    .min(1, { error: "Enter a title" })
    .max(120, { error: "Titles can be up to 120 characters" }),
  category: z.enum(DOCUMENT_CATEGORIES, { error: "Choose a category" }),
  file_name: z
    .string({ error: "Choose a file" })
    .max(1000, { error: "Choose a file" })
    .transform(cleanFileName)
    .pipe(z.string().min(1, { error: "Choose a file" }).max(200)),
  mime_type: z.string({ error: "Choose a file" }).max(100, { error: "Choose a file" }),
  size_bytes: z.number({ error: "Choose a file" }).int({ error: "Choose a file" }).positive({ error: "The file is empty" }),
};

export const GuardianUploadSchema = z.object({
  ...uploadBase,
  share_with_org_ids: z
    .array(uuid("Choose an organisation"), { error: "Choose an organisation" })
    .max(20)
    .optional()
    .transform((ids) => [...new Set(ids ?? [])]),
});
export type GuardianUploadInput = z.output<typeof GuardianUploadSchema>;

export const ProviderUploadSchema = z.object({
  ...uploadBase,
  visible_to_guardian: z.boolean({ error: "Say whether the parent can see this document" }).optional().default(true),
});
export type ProviderUploadInput = z.output<typeof ProviderUploadSchema>;

export const VisibilitySchema = z.object({
  visible_to_guardian: z.boolean({ error: "Say whether the parent can see this document" }),
});

export const ShareSchema = z.object({ org_id: uuid("Choose an organisation") });
