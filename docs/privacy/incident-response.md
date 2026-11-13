# Personal data breach and incident response (ticket 041, FR-11)

Status: **draft - pending legal review.** Applies to the DoctorNearMe pilot (children's health data, DPDP Act 2023 and
the DPDP Rules). Keep a printed copy with the on-call contacts.

## 1. Detection sources

- `/admin/ops`: outbox backlog / dead deliveries, failed processor deletions, retention job not run, recordings stuck
  in processing.
- `/admin/audit`: unusual actions (bulk downloads `document.downloaded` / `privacy.export_downloaded`, role and
  membership changes, link revocations, `audit.viewed` by unexpected admins).
- `GET /api/health` monitoring (503 = database unreachable).
- Supabase dashboard (auth logs, API logs, storage access), Vercel logs, provider alerts (ElevenLabs, Google, Resend,
  Meta).
- Reports from clinics, families or researchers (grievance officer mailbox `GRIEVANCE_OFFICER_EMAIL`).

## 2. Severity levels

| Level | Examples | Response |
|-------|----------|----------|
| SEV-1 (breach confirmed) | Service-role key or database credentials leaked; child health data, recordings or documents accessed by an unauthorised person; cross-tenant data exposure | Immediately; incident lead on call; reporting clock starts (section 4) |
| SEV-2 (suspected breach) | Signed URLs or tokens exposed in logs or chats; a processor reports an incident; suspicious bulk access in the audit log | Within 1 hour; treat as SEV-1 until ruled out |
| SEV-3 (security weakness, no access) | Vulnerability found, misconfigured bucket without evidence of access, failed deletions piling up | Within 1 business day |

## 3. Roles

- **Incident lead** (product owner until a DPO is appointed): decides severity, owns the timeline and the reports.
- **Technical lead**: containment, evidence, fixes.
- **Communications**: guardians, clinics, processors; uses the templates below.
- **Legal advisor** (external): reviews notices to the Board and to affected people.

## 4. Reporting timeline (DPDP Rules)

1. **Without delay** after becoming aware of a personal data breach: intimate the **Data Protection Board of India**
   with a description (nature, extent, timing, location, likely impact), and inform **each affected Data Principal
   (guardian)** in plain language through the app and email (template 7.2).
2. **Within 72 hours** of becoming aware (or longer if the Board allows): a **detailed report to the Board** - updated
   facts, circumstances and reasons, mitigation measures, findings about the person who caused it, remedial measures to
   prevent recurrence, and the report on the intimations sent to affected people.
3. Inform the affected clinics (organisation owners) at the same time as guardians; they may have their own duties.
4. Record every step with times in the incident log (section 6).

## 5. Containment steps

- **Rotate keys**: Supabase service-role / secret key and JWT secret (all sessions end), `DATABASE_URL` password,
  `CRON_SECRET`, `ELEVENLABS_API_KEY`, `ELEVENLABS_WEBHOOK_SECRET`, `GEMINI_API_KEY`, `RESEND_API_KEY`,
  `WHATSAPP_TOKEN`, `CONSENT_IP_SALT` (only if the hash is at risk). Redeploy.
- **Revoke tokens**: intake links (`cases.intake_token_revoked_at`), referral links (`referrals.status = 'revoked'`),
  claim codes (`child_claim_codes.expires_at = now()`), invitations (`org_invitations.revoked_at`), sharing grants
  (`sharing_grants.revoked_at`), outstanding exports (`privacy_exports.status = 'expired'`, remove objects); sign out
  affected users (Supabase admin) and suspend compromised accounts.
- **Disable agents and processors**: unpublish or disable the ElevenLabs agents (intake, screen, booking, follow-up),
  set `DEMO_MODE=true` to stop outbound email/WhatsApp, pause the cron jobs in Vercel if a job is implicated.
- **Restrict access**: make buckets private (they are), remove compromised org members, platform admins revoke guardian
  links if needed.

## 6. Evidence preservation

- Do **not** delete or edit audit rows (they are append-only; never use the maintenance functions during an incident).
- Export the relevant `audit_events` range (`/admin/audit` filters or SQL), Supabase auth/API/storage logs, Vercel
  logs and processor logs before they rotate; store them encrypted with restricted access.
- Pause the retention job (`/api/cron/retention`) if it would delete evidence (audio, exports, notification text).
- Keep an incident log: time, person, action, evidence reference.

## 7. Communication templates

### 7.1 Data Protection Board - intimation (first notice)

> DoctorNearMe (data fiduciary) reports a personal data breach discovered on <date, time IST>. Nature: <what
> happened>. Data affected: <categories, e.g. children's health profiles, session recordings>. Approximate number of
> Data Principals: <n>. Likely impact: <impact>. Containment so far: <steps>. Contact: <incident lead, email, phone>.
> A detailed report will follow within 72 hours.

### 7.2 Guardians (in-app notification + email, plain language, en/hi/te)

> We are writing to tell you about a security problem that affected your child's information on DoctorNearMe. On
> <date> we found that <what happened in one sentence>. The information involved: <list>. What we have done: <steps>.
> What you can do: <e.g. watch for messages claiming to be from your clinic; you can download or delete your child's
> data from the Privacy page>. Questions: <grievance officer email>. You can also complain to the Data Protection
> Board of India.

### 7.3 Clinics (organisation owners)

> A security incident on DoctorNearMe affected records of your organisation: <scope>. We have <containment>. Please
> <actions, e.g. check your team list, re-invite members after the password reset>. Contact: <incident lead>.

### 7.4 Processors

> Please confirm whether <processor> holds data for project <id> related to <incident>, preserve logs for
> <period>, and delete <conversation ids / objects> when we confirm.

## 8. After the incident

- Detailed report to the Board within 72 hours (section 4.2); final report when the investigation closes.
- Post-incident review within 2 weeks: root cause, fixes, tests added, this procedure updated.
- Review whether consent texts, processors or retention periods must change.
