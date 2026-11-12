import { randomUUID } from "node:crypto";
import { audit } from "@/lib/audit";
import { requireProviderProfileOwner } from "@/lib/authz";
import { supabaseAdmin } from "@/lib/db";
import { fail, ok } from "@/lib/http";
import { photoUrl, setPhotoPath } from "@/lib/providers";
import { MAX_PHOTO_BYTES, PHOTO_BUCKET } from "@/lib/providers/constants";
import { sniffType, stripImageMetadata } from "@/lib/providers/images";
import { invalidatePublicProviders } from "@/lib/providers/public";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function removeObject(path: string | null) {
  if (!path) return;
  const { error } = await supabaseAdmin().storage.from(PHOTO_BUCKET).remove([path]);
  if (error) console.error(`photo cleanup failed: ${error.message}`);
}

// FR-3 photo: JPEG/PNG up to 2 MB, type checked from the bytes, metadata (EXIF/XMP/text chunks) stripped,
// stored under a random name in the public `provider-photos` bucket (D-6).
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderProfileOwner(id);
  if ("response" in gate) return gate.response;

  let file: FormDataEntryValue | null = null;
  try {
    file = (await req.formData()).get("file");
  } catch {
    return fail(400, "Invalid request", { file: "Send the photo as multipart form data" });
  }
  if (!(file instanceof Blob) || file.size === 0) return fail(400, "Invalid request", { file: "Choose a photo" });
  if (file.size > MAX_PHOTO_BYTES) return fail(400, "Invalid request", { file: "Photo too large (max 2 MB)" });

  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = sniffType(bytes);
  if (type !== "image/jpeg" && type !== "image/png") {
    return fail(400, "Invalid request", { file: "Upload a JPEG or PNG photo" });
  }
  let clean: Uint8Array;
  try {
    clean = stripImageMetadata(bytes, type);
  } catch {
    return fail(400, "Invalid request", { file: "This image could not be read" });
  }

  const path = `${id}/${randomUUID()}.${type === "image/jpeg" ? "jpg" : "png"}`;
  const { error } = await supabaseAdmin()
    .storage.from(PHOTO_BUCKET)
    .upload(path, clean, { contentType: type, upsert: false, cacheControl: "31536000" });
  if (error) return fail(500, "Could not upload the photo");

  const previous = await setPhotoPath(id, path);
  await removeObject(previous);
  await audit({
    actor: "therapist",
    actorUserId: gate.actor.user.id,
    action: "provider.photo_updated",
    entity: "provider_profile",
    entityId: id,
  });
  invalidatePublicProviders();
  return ok({ photo_url: photoUrl(path) }, 201);
}

export async function DELETE(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const gate = await requireProviderProfileOwner(id);
  if ("response" in gate) return gate.response;
  const previous = await setPhotoPath(id, null);
  await removeObject(previous);
  invalidatePublicProviders();
  return ok({ photo_url: null });
}
