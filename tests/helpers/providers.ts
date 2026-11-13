// Shared setup for the ticket 028 DB suites (provider profiles, verification, claim links). Synthetic users,
// organisations and profiles only; everything created through these helpers is removed by `cleanup()`.
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Sql } from "postgres";

export type TestUser = { id: string; email: string };

export function providerFixtures(prefix: string, getDb: () => SupabaseClient, getSql: () => Sql) {
  const tag = randomUUID().slice(0, 8);
  const users: string[] = [];
  const objects: { bucket: string; path: string }[] = [];

  async function makeUser(name: string, role?: "platform_admin" | "guardian" | "provider"): Promise<TestUser> {
    const email = `${prefix}-${name}-${tag}@example.com`;
    const { data, error } = await getDb().auth.admin.createUser({
      email,
      email_confirm: true,
      password: randomUUID(),
      app_metadata: role === "platform_admin" ? { role } : {},
    });
    if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);
    users.push(data.user.id);
    // GoTrue may store app_metadata after the insert trigger ran, so set the role explicitly.
    if (role) await getSql()`update user_profiles set role = ${role} where id = ${data.user.id}`;
    return { id: data.user.id, email };
  }

  function track(userId: string) {
    users.push(userId);
  }

  function trackObject(bucket: string, path: string) {
    objects.push({ bucket, path });
  }

  async function cleanup() {
    const sql = getSql();
    if (users.length) {
      const profiles = await sql<{ id: string }[]>`
        select id from provider_profiles where user_id in ${sql(users)} or created_by in ${sql(users)}`;
      const orgs = await sql<{ id: string }[]>`
        select id from organizations where created_by in ${sql(users)}
        union select org_id from org_members where user_id in ${sql(users)} and org_id <> '00000000-0000-4000-8000-00000000a001'`;
      const profileIds = profiles.map((p) => p.id);
      if (profileIds.length) {
        const stored = await sql<{ bucket: string; path: string }[]>`
          select 'credentials' as bucket, certificate_path as path from credential_submissions
            where provider_profile_id in ${sql(profileIds)} and certificate_path is not null
          union select 'provider-photos', photo_path from provider_profiles where id in ${sql(profileIds)} and photo_path is not null`;
        objects.push(...stored);
        // Uploads that were never submitted (or were replaced) live under the profile id prefix.
        for (const bucket of ["credentials", "provider-photos"]) {
          for (const id of profileIds) {
            const { data } = await getDb().storage.from(bucket).list(id);
            for (const file of data ?? []) objects.push({ bucket, path: `${id}/${file.name}` });
          }
        }
        await sql`delete from audit_events where entity_id in ${sql(profileIds)} or details ->> 'provider_profile_id' in ${sql(profileIds)}`;
        // 032: provider decisions enqueue outbox events (notifications cascade).
        await sql`delete from outbox_events where aggregate_type = 'provider_profile' and aggregate_id in ${sql(profileIds)}`;
        await sql`delete from provider_profiles where id in ${sql(profileIds)}`;
      }
      if (orgs.length) await sql`delete from organizations where id in ${sql(orgs.map((o) => o.id))}`;
    }
    for (const { bucket, path } of objects) await getDb().storage.from(bucket).remove([path]);
    for (const id of users) await getDb().auth.admin.deleteUser(id);
  }

  return { tag, makeUser, track, trackObject, cleanup };
}

export function jsonRequest(url: string, method: string, body?: unknown): Request {
  return new Request(`http://localhost${url}`, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

// Minimal synthetic JPEG: SOI, APP0 (JFIF), APP1 (EXIF with a fake GPS marker), COM, DQT, SOS + data, EOI.
export function syntheticJpeg(): Uint8Array {
  const seg = (marker: number, payload: number[]) => [0xff, marker, (payload.length + 2) >> 8, (payload.length + 2) & 0xff, ...payload];
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return new Uint8Array([
    0xff, 0xd8,
    ...seg(0xe0, [...ascii("JFIF"), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0]),
    ...seg(0xe1, [...ascii("Exif"), 0, 0, ...ascii("GPS 17.4N 78.4E SYNTHETIC")]),
    ...seg(0xfe, ascii("camera owner")),
    ...seg(0xdb, [0, ...new Array(64).fill(1)]),
    ...seg(0xda, [1, 1, 0, 0, 63, 0]),
    0x12, 0x34, 0xff, 0x00, 0x56,
    0xff, 0xd9,
  ]);
}

function crc32(bytes: Uint8Array): number {
  let crc = ~0;
  for (const b of bytes) {
    crc ^= b;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: number[]): number[] {
  const body = new Uint8Array([...[...type].map((c) => c.charCodeAt(0)), ...data]);
  const crc = crc32(body);
  const len = data.length;
  return [len >>> 24, (len >> 16) & 255, (len >> 8) & 255, len & 255, ...body, crc >>> 24, (crc >> 16) & 255, (crc >> 8) & 255, crc & 255];
}

// 1x1 PNG with a tEXt chunk carrying a fake author and an eXIf chunk.
export function syntheticPng(): Uint8Array {
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...pngChunk("IHDR", [0, 0, 0, 1, 0, 0, 0, 1, 8, 0, 0, 0, 0]),
    ...pngChunk("tEXt", [...ascii("Author"), 0, ...ascii("Synthetic Person")]),
    ...pngChunk("eXIf", ascii("MM GPS")),
    ...pngChunk("IDAT", [0x78, 0x9c, 0x63, 0x60, 0x00, 0x00, 0x00, 0x02, 0x00, 0x01]),
    ...pngChunk("IEND", []),
  ]);
}

export const SYNTHETIC_PDF = new TextEncoder().encode("%PDF-1.4\n% synthetic test certificate\n1 0 obj << >> endobj\ntrailer << >>\n%%EOF\n");
