// 036 request bodies (API errors stay English; the forms show translated messages by status).
import { z } from "zod";
import { COMMENT_MAX } from "./rules";

const comment = z
  .string()
  .max(COMMENT_MAX * 2, `Comment must be at most ${COMMENT_MAX} characters`)
  .transform((v) => v.trim())
  .refine((v) => v.length <= COMMENT_MAX, `Comment must be at most ${COMMENT_MAX} characters`)
  .nullable()
  .optional();

const stars = z.number().int("Stars must be a whole number").min(1, "Choose 1 to 5 stars").max(5, "Choose 1 to 5 stars");

export const RatingCreateSchema = z.object({ stars, comment }).strict();

export const RatingUpdateSchema = z
  .object({ stars: stars.optional(), comment })
  .strict()
  .refine((v) => v.stars !== undefined || v.comment !== undefined, { message: "Nothing to change", path: ["body"] });

export const RatingReportSchema = z
  .object({ reason: z.string().trim().min(3, "Tell us briefly what is wrong").max(500, "Reason must be at most 500 characters") })
  .strict();

export const RatingModerateSchema = z
  .object({
    action: z.enum(["publish", "hide"]),
    note: z.string().trim().max(500, "Note must be at most 500 characters").optional(),
  })
  .strict()
  .refine((v) => v.action !== "hide" || (v.note?.length ?? 0) >= 3, { message: "Add a note saying why the rating is hidden", path: ["note"] });

export type RatingCreate = z.output<typeof RatingCreateSchema>;
export type RatingUpdate = z.output<typeof RatingUpdateSchema>;
export type RatingModerate = z.output<typeof RatingModerateSchema>;
