// Ticket 027: messaging limits and API error texts. Safe in the browser (no server imports).
// API error bodies stay English (contract); the UI maps statuses to translated text.

export const SUBJECT_MAX = 120;
export const BODY_MAX = 4000;
export const PAGE_LIMIT = 50;
export const PAGE_LIMIT_MAX = 100;
export const RATE_LIMIT = { messages: 30, windowMinutes: 5 } as const;
export const DELETE_WINDOW_MINUTES = 15;
/** FR-5 fallback when Realtime is unavailable; while Realtime is live a slower check still detects revocation. */
export const POLL_INTERVAL_MS = 15_000;
export const LIVE_CHECK_INTERVAL_MS = 60_000;

/** What deleted messages show for everyone (also written over the stored body). */
export const DELETED_BODY = "This message was deleted.";

export const MESSAGING_ERRORS = {
  threadNotFound: "Conversation not found",
  messageNotFound: "Message not found",
  caseNotFound: "Case not found",
  childNotFound: "Child not found",
  noGuardian: "No parent account is linked to this child yet",
  tooFast: "You're sending messages too fast",
  archived: "This conversation is archived",
  documentNotAttachable: "Everyone in this conversation must be able to see this document",
  clientIdConflict: "This message id was already used for another conversation",
  notOwn: "You can only delete your own messages",
  tooLate: `Messages can only be deleted within ${DELETE_WINDOW_MINUTES} minutes`,
  archiveForbidden: "Only an organisation owner or admin can archive a conversation",
  saveFailed: "Could not send. Please try again.",
} as const;
