// 041 FR-2 / D-3: security-critical actions. Each one writes its audit row in the same transaction as the change
// and fails closed (503 `Could not save. Please try again.`, nothing saved) when the audit row cannot be written.
// `tests/audit-hardening.test.ts` checks every entry statically (the route calls `call`, and `module` uses
// `auditStrict(` - or, for `sql`, the database function inserts into audit_events and the module honours the
// AUDIT_FAIL_ACTIONS dev hook) and at runtime for a representative set.
//
// Two implementations count as strict:
//   * `auditStrict`: TypeScript `sql.begin` transaction with `auditStrict(event, tx)` (lib/audit.ts);
//   * `sql`: one security-definer database function that performs the change and inserts its audit row (020/022/023
//     style). Strictly equivalent: the function is one transaction.
// Later tickets add their actions here (039: `rx.signed`).

export type StrictActionImpl =
  | { kind: "auditStrict"; module: string }
  | { kind: "sql"; module: string; fn: string; migration: string };

export type StrictAction = {
  action: string;
  description: string;
  /** Route files (repo-relative) that perform the action. */
  routes: string[];
  /** The function the routes call to perform it. */
  call: string;
  impl: StrictActionImpl;
};

const CONSENT_SQL: StrictActionImpl = {
  kind: "sql",
  module: "lib/consent/records.ts",
  fn: "record_consent",
  migration: "supabase/migrations/20261113002000_children_consent.sql",
};

export const STRICT_ACTIONS: StrictAction[] = [
  // ---------- 020 consent ----------
  {
    action: "consent.granted",
    description: "Guardian allows an AI feature (digital consent)",
    routes: ["app/api/family/children/[id]/consents/route.ts"],
    call: "recordConsent",
    impl: CONSENT_SQL,
  },
  {
    action: "consent.withdrawn",
    description: "Guardian or provider (paper) withdraws consent",
    routes: [
      "app/api/family/children/[id]/consents/[feature]/withdraw/route.ts",
      "app/api/cases/[id]/paper-consents/withdraw/route.ts",
    ],
    call: "recordConsent",
    impl: CONSENT_SQL,
  },
  {
    action: "consent.paper_recorded",
    description: "Provider records a signed paper consent form",
    routes: ["app/api/cases/[id]/paper-consents/route.ts"],
    call: "recordConsent",
    impl: CONSENT_SQL,
  },
  // ---------- 020 guardian links ----------
  {
    action: "child.claimed",
    description: "Guardian links a clinic record with a claim code",
    routes: ["app/api/family/claims/route.ts"],
    call: "claimChild",
    impl: {
      kind: "sql",
      module: "lib/children/index.ts",
      fn: "claim_child",
      migration: "supabase/migrations/20261113002000_children_consent.sql",
    },
  },
  {
    action: "guardian.left_child",
    description: "Guardian removes their own link to a child",
    routes: ["app/api/family/children/[id]/leave/route.ts"],
    call: "leaveChild",
    impl: { kind: "auditStrict", module: "lib/children/links.ts" },
  },
  {
    action: "guardian.link_revoked",
    description: "Platform admin revokes a guardian link",
    routes: ["app/api/admin/guardian-links/[id]/revoke/route.ts"],
    call: "adminRevokeGuardianLink",
    impl: { kind: "auditStrict", module: "lib/children/links.ts" },
  },
  // ---------- 022 sharing and care team ----------
  {
    action: "sharing.granted",
    description: "Guardian shares records with another organisation",
    routes: ["app/api/family/children/[id]/sharing-grants/route.ts"],
    call: "createSharingGrant",
    impl: {
      kind: "sql",
      module: "lib/sharing/grants.ts",
      fn: "create_sharing_grant",
      migration: "supabase/migrations/20261113002200_care_team_sharing.sql",
    },
  },
  {
    action: "sharing.revoked",
    description: "Guardian stops sharing",
    routes: ["app/api/family/children/[id]/sharing-grants/[grantId]/revoke/route.ts"],
    call: "revokeSharingGrant",
    impl: {
      kind: "sql",
      module: "lib/sharing/grants.ts",
      fn: "revoke_sharing_grant",
      migration: "supabase/migrations/20261113002200_care_team_sharing.sql",
    },
  },
  {
    action: "case.assigned",
    description: "Provider added to a case's care team",
    routes: ["app/api/cases/[id]/assignments/route.ts"],
    call: "addAssignment",
    impl: {
      kind: "sql",
      module: "lib/cases/team.ts",
      fn: "add_case_assignment",
      migration: "supabase/migrations/20261113002200_care_team_sharing.sql",
    },
  },
  {
    action: "case.unassigned",
    description: "Provider removed from a case's care team",
    routes: ["app/api/cases/[id]/assignments/[assignmentId]/route.ts"],
    call: "removeAssignment",
    impl: {
      kind: "sql",
      module: "lib/cases/team.ts",
      fn: "remove_case_assignment",
      migration: "supabase/migrations/20261113002200_care_team_sharing.sql",
    },
  },
  // ---------- 023 documents ----------
  {
    action: "document.downloaded",
    description: "A document is opened (signed URL minted only after the audit row)",
    routes: ["app/api/documents/[docId]/download/route.ts"],
    call: "downloadUrl",
    impl: {
      kind: "sql",
      module: "lib/documents/store.ts",
      fn: "log_document_download",
      migration: "supabase/migrations/20261113002300_documents.sql",
    },
  },
  {
    action: "document.deleted",
    description: "A document is deleted",
    routes: ["app/api/documents/[docId]/route.ts"],
    call: "deleteDocument",
    impl: {
      kind: "sql",
      module: "lib/documents/store.ts",
      fn: "delete_document",
      migration: "supabase/migrations/20261113002300_documents.sql",
    },
  },
  // ---------- 017 organisations ----------
  {
    action: "org.invitation_created",
    description: "Org owner/admin invites a provider",
    routes: ["app/api/orgs/[id]/invitations/route.ts"],
    call: "createInvitation",
    impl: { kind: "auditStrict", module: "lib/orgs.ts" },
  },
  {
    action: "org.invitation_revoked",
    description: "Org owner/admin revokes an invitation",
    routes: ["app/api/orgs/[id]/invitations/[invitationId]/route.ts"],
    call: "revokeInvitation",
    impl: { kind: "auditStrict", module: "lib/orgs.ts" },
  },
  {
    action: "org.invitation_accepted",
    description: "Invited user joins an organisation (role change for guardians)",
    routes: ["app/api/invitations/accept/route.ts"],
    call: "acceptInvitation",
    impl: { kind: "auditStrict", module: "lib/orgs.ts" },
  },
  {
    action: "org.member_revoked",
    description: "Org owner/admin removes a member",
    routes: ["app/api/orgs/[id]/members/[userId]/route.ts"],
    call: "revokeMember",
    impl: { kind: "auditStrict", module: "lib/orgs.ts" },
  },
  // ---------- 028 role change (guardian account becomes a provider) ----------
  {
    action: "provider.registered",
    description: "An account registers as a provider (role change)",
    routes: ["app/api/providers/register/route.ts"],
    call: "registerProvider",
    impl: { kind: "auditStrict", module: "lib/providers/index.ts" },
  },
  // ---------- 041 export and deletion ----------
  {
    action: "privacy.export_requested",
    description: "Guardian requests a copy of the child's data",
    routes: ["app/api/family/children/[id]/exports/route.ts"],
    call: "requestExport",
    impl: { kind: "auditStrict", module: "lib/privacy/export.ts" },
  },
  {
    action: "privacy.export_downloaded",
    description: "Guardian downloads a finished export",
    routes: ["app/api/family/exports/[id]/download/route.ts"],
    call: "exportDownloadUrl",
    impl: { kind: "auditStrict", module: "lib/privacy/export.ts" },
  },
  {
    action: "privacy.deletion_requested",
    description: "Guardian asks for the child's data to be deleted",
    routes: ["app/api/family/children/[id]/deletion-requests/route.ts"],
    call: "createDeletionRequest",
    impl: { kind: "auditStrict", module: "lib/privacy/deletion.ts" },
  },
  {
    action: "privacy.deletion_reviewed",
    description: "Platform admin approves or rejects a deletion request",
    routes: ["app/api/admin/privacy/requests/[id]/route.ts"],
    call: "reviewDeletionRequest",
    impl: { kind: "auditStrict", module: "lib/privacy/deletion.ts" },
  },
  // ---------- 033 public check-in ----------
  {
    action: "screen.result_saved",
    description: "Guardian saves a public developmental check-in result to a child",
    routes: ["app/api/family/screen-results/route.ts"],
    call: "saveScreenResult",
    impl: { kind: "auditStrict", module: "lib/screen/store.ts" },
  },
  // ---------- 038 AI scribe: publishing a session note (guardian visibility) ----------
  {
    action: "scribe.note_finalized",
    description: "Provider finalizes an AI-drafted session note (published, optionally visible to the guardian)",
    routes: ["app/api/sessions/[id]/scribe/route.ts"],
    call: "finalizeSessionNote",
    impl: { kind: "auditStrict", module: "lib/scribe/notes.ts" },
  },
  {
    action: "scribe.note_sharing_changed",
    description: "Provider shares or stops sharing a final session note with the guardian",
    routes: ["app/api/sessions/[id]/scribe/route.ts"],
    call: "setSessionNoteSharing",
    impl: { kind: "auditStrict", module: "lib/scribe/notes.ts" },
  },
  // ---------- 026 home program ----------
  {
    action: "home_program.published",
    description: "Provider publishes a home program to the guardian (024 published version + activity snapshot)",
    routes: ["app/api/home-programs/[pid]/publish/route.ts"],
    call: "publishProgram",
    impl: { kind: "auditStrict", module: "lib/home-program/index.ts" },
  },
  {
    action: "home_program.log_deleted",
    description: "Guardian removes one of their own practice logs",
    routes: ["app/api/family/home-activity-logs/[id]/route.ts"],
    call: "deleteOwnLog",
    impl: { kind: "auditStrict", module: "lib/home-program/index.ts" },
  },
  // ---------- 027 messaging (message + outbox event + audit row in one database function) ----------
  {
    action: "thread.created",
    description: "Guardian or provider starts a conversation (first message included)",
    routes: ["app/api/threads/route.ts"],
    call: "createThread",
    impl: { kind: "sql", module: "lib/messaging/store.ts", fn: "create_message_thread", migration: "supabase/migrations/20261113002700_messaging.sql" },
  },
  {
    action: "message.sent",
    description: "Message sent in a conversation",
    routes: ["app/api/threads/[id]/messages/route.ts"],
    call: "sendMessage",
    impl: { kind: "sql", module: "lib/messaging/store.ts", fn: "send_thread_message", migration: "supabase/migrations/20261113002700_messaging.sql" },
  },
  {
    action: "message.deleted",
    description: "Sender deletes their message (text overwritten for everyone)",
    routes: ["app/api/messages/[id]/route.ts"],
    call: "deleteMessage",
    impl: { kind: "sql", module: "lib/messaging/store.ts", fn: "delete_thread_message", migration: "supabase/migrations/20261113002700_messaging.sql" },
  },
  {
    action: "thread.archived",
    description: "Owner/admin archives a conversation",
    routes: ["app/api/threads/[id]/archive/route.ts"],
    call: "archiveThread",
    impl: { kind: "sql", module: "lib/messaging/store.ts", fn: "archive_message_thread", migration: "supabase/migrations/20261113002700_messaging.sql" },
  },
  // ---------- 037 Google Meet (OAuth grants and links shown to families) ----------
  {
    action: "google_calendar.connected",
    description: "Provider connects Google Calendar (encrypted refresh token stored)",
    routes: ["app/api/integrations/google/callback/route.ts"],
    call: "saveGoogleConnection",
    impl: { kind: "auditStrict", module: "lib/google/connections.ts" },
  },
  {
    action: "google_calendar.disconnected",
    description: "Provider disconnects Google Calendar (token revoked at Google and deleted)",
    routes: ["app/api/integrations/google/disconnect/route.ts"],
    call: "disconnectGoogle",
    impl: { kind: "auditStrict", module: "lib/google/connections.ts" },
  },
  {
    action: "appointment.meet_link_set",
    description: "Provider adds a video link by hand to a video appointment",
    routes: ["app/api/appointments/[id]/meet-link/route.ts"],
    call: "setManualMeetLink",
    impl: { kind: "auditStrict", module: "lib/google/meet.ts" },
  },
  // ---------- 031 payments ----------
  {
    action: "payment.captured",
    description: "A payment is captured and the appointment confirmed (checkout handler; the webhook uses the same function)",
    routes: ["app/api/payments/verify/route.ts"],
    call: "applyPaymentCaptured",
    impl: { kind: "auditStrict", module: "lib/payments/store.ts" },
  },
];

export function strictAction(action: string): StrictAction | undefined {
  return STRICT_ACTIONS.find((a) => a.action === action);
}
