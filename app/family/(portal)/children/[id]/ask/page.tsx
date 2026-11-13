import Link from "next/link";
import { FollowupChat } from "@/components/followup/FollowupChat";
import { requireChildGuardianPage, requireGuardianPage } from "@/lib/authz";
import { hasConsent } from "@/lib/consent";
import { isDemoMode } from "@/lib/demo";
import { env } from "@/lib/env";
import { DAILY_QUESTION_LIMIT } from "@/lib/followup/constants";
import { listHistory, questionsUsed } from "@/lib/followup/store";
import { getT } from "@/lib/i18n/server";

export const dynamic = "force-dynamic";

// Ticket 040 FR-4: `Ask about <child>'s plan`. Guardian of this child only (else 404). Without `ai_follow_up` consent
// the page explains how to turn the assistant on and offers no input. Voice (FR-5) is offered in DEMO_MODE or when the
// follow-up agent and its tool secret are configured; the text chat is always there.
export default async function AskPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requireGuardianPage();
  const { id } = await params;
  const { child } = await requireChildGuardianPage(id);
  const t = await getT("followup");
  const granted = await hasConsent(child.id, "ai_follow_up").catch(() => false);
  const [history, used] = granted ? await Promise.all([listHistory(session.user.id, child.id), questionsUsed(session.user.id)]) : [[], 0];
  const demo = isDemoMode();
  const voiceAvailable = demo || Boolean(env.ELEVENLABS_FOLLOWUP_AGENT_ID && env.ELEVENLABS_TOOL_SECRET);

  return (
    <div className="space-y-6">
      <Link href={`/family/children/${child.id}`} className="inline-flex min-h-11 items-center text-sm font-semibold text-teal-800 underline">
        {t("back", { name: child.display_name })}
      </Link>
      <header className="space-y-1">
        <h1 className="text-2xl font-bold break-words text-slate-900 sm:text-3xl">{t("title", { name: child.display_name })}</h1>
        <p className="text-slate-700">{t("intro", { name: child.display_name })}</p>
      </header>
      {granted ? (
        <FollowupChat
          childId={child.id}
          childName={child.display_name}
          history={history}
          remaining={Math.max(0, DAILY_QUESTION_LIMIT - used)}
          voice={{ available: voiceAvailable, demo }}
        />
      ) : (
        <section aria-labelledby="followup-consent" className="space-y-2 rounded-2xl border border-slate-200 bg-white p-4" data-testid="followup-consent-needed">
          <h2 id="followup-consent" className="text-lg font-semibold text-slate-900">
            {t("consentNeeded.title")}
          </h2>
          <p className="text-slate-700">{t("consentNeeded.body", { name: child.display_name })}</p>
          <Link href={`/family/children/${child.id}#permissions-heading`} className="inline-flex min-h-11 items-center font-semibold text-teal-800 underline">
            {t("consentNeeded.link")}
          </Link>
        </section>
      )}
    </div>
  );
}
