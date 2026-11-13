# Processors (ticket 041, FR-11)

Status: **draft - contracts and regions to be confirmed by a human** (legal review, risk 6 in the decision record).
Shown to families on `/privacy` and in every consent text (020 `consent_documents.processors`).

| Processor | Used for | Personal data sent | Region | Deletion | Contract / terms status |
|-----------|----------|--------------------|--------|----------|-------------------------|
| ElevenLabs (Conversational AI, Speech-to-Text, TTS) | AI intake voice call (009/010), session transcription (005), parent voice summary (015) | Call audio and transcript (parent's voice, child's first name and development details), session audio, report summary text | USA | `DELETE /v1/convai/conversations/{conversation_id}` for every `recordings.external_id` on erasure (`lib/elevenlabs/conversations.ts`, `processor_deletions`). STT/TTS requests are not stored as conversations | Open: DPA, zero-retention mode for STT, data residency options |
| Google Gemini API | Fact extraction, report drafts, intake briefs, Ask-the-case answers | Transcripts, case sheet answers, facts | Outside India (Google data centres) | No deletion API: recorded as `not_applicable` per request. Rely on paid-tier terms (no training, no long-term retention) | Open: confirm paid-tier terms for the pilot project (rd open question) |
| Resend | Transactional email (invitations, intake links, notifications) | Recipient email, subject and text (no child name or clinical content in notifications, 032 D-5) | USA | Delivery log rows stripped after 90 days (`delivery_content`); provider logs per Resend retention | Open: DPA |
| Meta WhatsApp Cloud API | Optional notifications (opt-in) | Recipient phone number, approved template parameters (a link only) | Outside India (Meta data centres) | Delivery log rows stripped after 90 days | Open: business verification, template approval (032) |
| Razorpay (031, **test mode** until go-live) | Online prepayment and refunds for appointments | Order amount, appointment id (receipt/notes), the guardian's name (checkout prefill); card/UPI details are entered on Razorpay's checkout and never reach the app | India | Payment records are kept by Razorpay under RBI / accounting rules; nothing to delete per child (no child data sent) | Open: merchant agreement, live-mode activation (out of scope for the pilot build) |
| Supabase | Database, auth, file storage | Everything stored by the app | `SUPABASE_REGION_LABEL` (pilot: consider Mumbai, risk 6) | Rows/objects deleted by retention and erasure | Open: DPA, region decision |

Notes

- Google Maps / Places (029) receive only the searcher's typed text or coordinates (not stored) and provider addresses;
  no child data.
- No analytics, advertising, tag manager or social pixel runs on any page for families (D-6, `tests/no-tracking.test.ts`).
  Approved third-party scripts on child pages: ElevenLabs SDK (voice agent routes) and Razorpay checkout (payment
  routes), declared per route in `lib/privacy/third-party-allowlist.ts`.
- Adding a processor: add it here, to the privacy notice (`privacy.notice.processors.*`), to the consent texts of the
  features that use it (new consent document version), to `Processor` in `lib/privacy/registry.ts`, and, if it has a
  deletion API, to the erasure job.
