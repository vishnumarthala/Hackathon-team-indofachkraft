import { randomUUID } from "node:crypto";
import { z } from "zod";
import { audit } from "@/lib/audit";
import { requireCaseAccess } from "@/lib/authz";
import { requireCaseConsent } from "@/lib/consent";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok, parseJson } from "@/lib/http";
import { getCase } from "@/lib/queries/cases";
import { deleteRecording, insertSessionRecording, nextSessionNumber, RECORDINGS_BUCKET } from "@/lib/queries/recordings";

export const runtime = "nodejs";
export const maxDuration = 300;
export const dynamic = "force-dynamic";

const MAX_AUDIO_BYTES = 52_428_800;

const EXT_BY_MIME = {
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/wave": "wav",
  "audio/webm": "webm",
  "audio/ogg": "ogg",
} as const;
type AudioMime = keyof typeof EXT_BY_MIME;

const sizeError = { error: "File too large (max 50 MB)" };
const sessionSchema = z.object({
  file_name: z.string({ error: "File name is required" }).trim().min(1, { error: "File name is required" }).max(255),
  mime_type: z.enum(Object.keys(EXT_BY_MIME) as [AudioMime, ...AudioMime[]], { error: "Unsupported audio type" }),
  size_bytes: z.number(sizeError).int(sizeError).min(1, sizeError).max(MAX_AUDIO_BYTES, sizeError),
  consent: z.boolean().optional(),
});

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id: caseId } = await params;
  const denied = await requireCaseAccess(caseId);
  if (denied) return denied;
  const found = await getCase(caseId);
  if (!found) return fail(404, "Case not found");
  // 020 FR-7: no upload URL without the guardian's session_recording consent.
  const blocked = await requireCaseConsent(caseId, "session_recording");
  if (blocked) return blocked;

  const parsed = await parseJson(req, sessionSchema);
  if ("response" in parsed) return parsed.response;
  const { mime_type, consent } = parsed.data;

  const recordingId = randomUUID();
  const path = `${caseId}/${recordingId}.${EXT_BY_MIME[mime_type]}`;
  const sessionNumber = await nextSessionNumber(caseId);
  try {
    await insertSessionRecording({
      id: recordingId,
      case_id: caseId,
      session_number: sessionNumber,
      storage_path: path,
      mime_type,
    });
  } catch {
    return fail(500, "Could not create the session");
  }

  const { data, error } = await supabaseAdmin().storage.from(RECORDINGS_BUCKET).createSignedUploadUrl(path);
  if (error || !data) {
    await deleteRecording(recordingId);
    return fail(500, "Could not create the upload URL");
  }

  const base = { caseId, actor: "therapist" as const, entity: "recording", entityId: recordingId };
  await audit({ ...base, action: "recording.created", details: { session_number: sessionNumber, mime_type } });
  if (consent === true) await audit({ ...base, action: "recording.consent", details: { consent: true } });

  return ok(
    {
      recording_id: recordingId,
      session_number: sessionNumber,
      bucket: RECORDINGS_BUCKET,
      path,
      token: data.token,
      signed_url: data.signedUrl,
    },
    201,
  );
}
