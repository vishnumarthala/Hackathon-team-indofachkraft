// 037 FR-2: a provider's Google Calendar connection. The refresh token is stored AES-256-GCM encrypted (AAD = the
// provider profile) and is decrypted only server-side: by the outbox worker to get an access token, and by
// `disconnectGoogle` to revoke it at Google (NFR-1). Nothing here returns the token to a caller that renders it.
import { auditStrict, type SessionAuditActor } from "@/lib/audit";
import { errorMessage, logger } from "@/lib/log";
import { enqueue } from "@/lib/notify/outbox";
import { pg, type Queryable } from "@/lib/pg";
import { googleApi, GoogleError, type GoogleApi } from "./client";
import { decryptSecret, encryptSecret, refreshTokenAad, TokenDecryptError } from "./crypto";

const log = logger("google");

export type ConnectionStatus = "active" | "expired" | "revoked";

/** What the provider's settings page and API may see (never the token). */
export type ConnectionView = {
  provider_profile_id: string;
  google_email: string;
  scopes: string[];
  status: ConnectionStatus;
  connected_at: string;
  last_refreshed_at: string | null;
};

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

export async function getConnectionView(providerProfileId: string, sql?: Queryable): Promise<ConnectionView | null> {
  const db = sql ?? (await pg());
  const [row] = await db<Record<string, unknown>[]>`
    select provider_profile_id, google_email, scopes, status, connected_at, last_refreshed_at
    from public.provider_google_connections where provider_profile_id = ${providerProfileId}`;
  if (!row) return null;
  return {
    provider_profile_id: String(row.provider_profile_id),
    google_email: String(row.google_email),
    scopes: (row.scopes as string[]) ?? [],
    status: row.status as ConnectionStatus,
    connected_at: iso(row.connected_at) as string,
    last_refreshed_at: iso(row.last_refreshed_at),
  };
}

/** Stores (or replaces) the connection after a successful OAuth callback; strict audit in the same transaction. */
export async function saveGoogleConnection(input: {
  providerProfileId: string;
  googleEmail: string;
  refreshToken: string;
  scopes: string[];
  actor: SessionAuditActor;
}): Promise<void> {
  const sql = await pg();
  const blob = encryptSecret(input.refreshToken, refreshTokenAad(input.providerProfileId));
  await sql.begin(async (tx) => {
    const [previous] = await tx<{ status: string }[]>`
      select status from public.provider_google_connections where provider_profile_id = ${input.providerProfileId} for update`;
    await tx`
      insert into public.provider_google_connections
        (provider_profile_id, google_email, refresh_token_encrypted, scopes, connected_at, last_refreshed_at, status, connected_by, updated_at)
      values (${input.providerProfileId}, ${input.googleEmail}, ${blob}, ${input.scopes}, now(), now(), 'active', ${input.actor.actorUserId}, now())
      on conflict (provider_profile_id) do update set
        google_email = excluded.google_email, refresh_token_encrypted = excluded.refresh_token_encrypted, scopes = excluded.scopes,
        connected_at = now(), last_refreshed_at = now(), status = 'active', connected_by = excluded.connected_by, updated_at = now()`;
    await auditStrict(
      {
        ...input.actor,
        action: "google_calendar.connected",
        entity: "provider_profile",
        entityId: input.providerProfileId,
        details: { scopes: input.scopes, reconnect: Boolean(previous), previous_status: previous?.status ?? null },
      },
      tx,
    );
  });
}

/**
 * FR-2 Disconnect: revoke the token at Google, then delete it. The row is deleted even when Google cannot be reached
 * (the provider asked to disconnect); `revoked` says whether Google confirmed it.
 */
export async function disconnectGoogle(input: { providerProfileId: string; actor: SessionAuditActor; api?: GoogleApi }): Promise<{ disconnected: boolean; revoked: boolean }> {
  const sql = await pg();
  const [row] = await sql<{ refresh_token_encrypted: Uint8Array }[]>`
    select refresh_token_encrypted from public.provider_google_connections where provider_profile_id = ${input.providerProfileId}`;
  if (!row) return { disconnected: false, revoked: false };
  let revoked = false;
  try {
    const token = decryptSecret(row.refresh_token_encrypted, refreshTokenAad(input.providerProfileId));
    await (input.api ?? googleApi()).revoke(token);
    revoked = true;
  } catch (err) {
    log.warn(`revoke failed for profile ${input.providerProfileId}: ${err instanceof GoogleError || err instanceof TokenDecryptError ? err.message : errorMessage(err)}`);
  }
  await sql.begin(async (tx) => {
    await tx`delete from public.provider_google_connections where provider_profile_id = ${input.providerProfileId}`;
    await auditStrict(
      { ...input.actor, action: "google_calendar.disconnected", entity: "provider_profile", entityId: input.providerProfileId, details: { revoked_at_google: revoked } },
      tx,
    );
  });
  return { disconnected: true, revoked };
}

export class NotConnectedError extends Error {
  constructor(readonly status: "missing" | ConnectionStatus) {
    super(`google_${status === "missing" ? "not_connected" : status}`);
    this.name = "NotConnectedError";
  }
}

/** Worker only: a fresh access token for the provider's calendar. `invalid_grant` -> GoogleError (caller marks expired). */
export async function accessTokenFor(sql: Queryable, providerProfileId: string, api: GoogleApi = googleApi()): Promise<string> {
  const [row] = await sql<{ refresh_token_encrypted: Uint8Array; status: ConnectionStatus }[]>`
    select refresh_token_encrypted, status from public.provider_google_connections where provider_profile_id = ${providerProfileId}`;
  if (!row) throw new NotConnectedError("missing");
  if (row.status !== "active") throw new NotConnectedError(row.status);
  const refreshToken = decryptSecret(row.refresh_token_encrypted, refreshTokenAad(providerProfileId));
  const tokens = await api.refresh(refreshToken);
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    // Google rotated the refresh token: keep the new one.
    await sql`
      update public.provider_google_connections
      set refresh_token_encrypted = ${encryptSecret(tokens.refresh_token, refreshTokenAad(providerProfileId))}, last_refreshed_at = now(), updated_at = now()
      where provider_profile_id = ${providerProfileId}`;
  } else {
    await sql`update public.provider_google_connections set last_refreshed_at = now() where provider_profile_id = ${providerProfileId}`;
  }
  return tokens.access_token;
}

/** FR-2: `invalid_grant` on refresh -> `expired` + `Reconnect Google Calendar` for the provider (once per connection). */
export async function markConnectionExpired(sql: Queryable, providerProfileId: string): Promise<void> {
  const [row] = await sql<{ connected_at: Date }[]>`
    update public.provider_google_connections set status = 'expired', updated_at = now()
    where provider_profile_id = ${providerProfileId} and status = 'active'
    returning connected_at`;
  if (!row) return;
  log.info(`connection expired for profile ${providerProfileId}`);
  await enqueue(sql, {
    topic: "google_calendar.reconnect_required",
    aggregateType: "provider_profile",
    aggregateId: providerProfileId,
    payload: { provider_profile_id: providerProfileId },
    dedupKey: `google:${providerProfileId}:expired:${new Date(row.connected_at).getTime()}`,
  });
}
