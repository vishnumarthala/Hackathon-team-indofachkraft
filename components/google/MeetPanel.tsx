// 037 FR-4 / FR-5: the video-call part of an appointment card, rendered on the server at request time so the Meet
// link only reaches the page inside the join window (10 minutes before the start until 30 minutes after the end).
import { buttonClass } from "@/components/providers/request";
import { joinState, type MeetInfo } from "@/lib/google/meet";
import { getT } from "@/lib/i18n/server";
import { AddVideoLinkForm } from "./AddVideoLinkForm";

type Props = {
  appointment: { id: string; status: string; starts_at: string; ends_at: string };
  meet: MeetInfo | undefined;
  side: "guardian" | "provider";
  now?: Date;
};

export async function MeetPanel({ appointment, meet, side, now = new Date() }: Props) {
  if (appointment.status !== "confirmed" || !meet) return null;
  const t = await getT("booking.meet");
  const state = joinState(appointment.starts_at, appointment.ends_at, now);
  if (state === "closed") return null;
  const hasLink = Boolean(meet.meet_url) && (meet.meet_status === "created" || meet.meet_status === "manual");
  const note = (text: string) => <p className="text-sm text-slate-700">{text}</p>;

  if (side === "guardian") {
    if (!hasLink) return <div data-testid="meet-panel">{note(t("linkSoon"))}</div>;
    return (
      <div className="w-full space-y-2" data-testid="meet-panel">
        {state === "open" ? (
          <a href={meet.meet_url as string} target="_blank" rel="noopener noreferrer" className={buttonClass}>
            {t("join")}
          </a>
        ) : (
          note(t("opensSoon"))
        )}
        {note(t("joinHint"))}
      </div>
    );
  }

  return (
    <div className="w-full space-y-2" data-testid="meet-panel">
      {hasLink ? (
        <>
          {state === "open" ? (
            <a href={meet.meet_url as string} target="_blank" rel="noopener noreferrer" className={buttonClass}>
              {t("join")}
            </a>
          ) : (
            note(`${meet.meet_status === "manual" ? t("manual") : t("ready")} ${t("opensSoon")}`)
          )}
          {state === "open" && meet.meet_status === "manual" ? note(t("manual")) : null}
          {note(t("providerHint"))}
          {meet.meet_status === "manual" ? <AddVideoLinkForm appointmentId={appointment.id} change /> : null}
        </>
      ) : meet.meet_status === "failed" ? (
        <>
          <p role="note" className="rounded bg-amber-50 p-2 text-sm text-amber-900">{t("failed")}</p>
          <AddVideoLinkForm appointmentId={appointment.id} />
        </>
      ) : (
        note(t("pending"))
      )}
    </div>
  );
}
