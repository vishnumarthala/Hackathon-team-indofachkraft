// "Add to calendar" (.ics) for an appointment. The UID matches the email invites of the outbox (032): one calendar
// entry per reschedule chain (`origin_appointment_id`), so a downloaded file and later emails update the same entry.
import { env } from "@/lib/env";
import { buildIcs, icsUid } from "@/lib/notify/ics";
import type { IcsInvite } from "@/lib/notify/types";
import type { AppointmentView } from "./store";

export function appointmentInvite(a: Pick<AppointmentView, "id" | "status" | "starts_at" | "ends_at" | "service_snapshot" | "provider_name">, link: string): IcsInvite {
  const snap = a.service_snapshot;
  const where = snap.mode === "video" ? "Video consultation" : [snap.location?.name, snap.location?.address].filter(Boolean).join(", ");
  return {
    method: a.status === "cancelled" ? "CANCEL" : "REQUEST",
    start: a.starts_at,
    end: a.ends_at,
    summary: `${snap.name} with ${a.provider_name} (DoctorNearMe)`,
    description: `${snap.mode === "video" ? "Video consultation" : "In-clinic visit"}. Manage: ${link}`,
    ...(where ? { location: where } : {}),
    url: link,
  };
}

export function appointmentIcs(a: AppointmentView & { origin_appointment_id: string | null }, path = "/family/appointments"): string {
  const link = `${env.NEXT_PUBLIC_APP_URL.replace(/\/+$/, "")}${path}`;
  return buildIcs(appointmentInvite(a, link), { uid: icsUid("appointment", a.origin_appointment_id ?? a.id), sequence: 0 });
}
