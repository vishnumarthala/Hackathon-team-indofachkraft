"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { buttonClass, send } from "@/components/providers/request";
import { SlotPicker, type PickedSlot } from "./SlotPicker";

type ErrorKey = "slot_taken" | "slot_unavailable" | "too_soon" | "too_far" | "too_late" | "invalid_transition" | "generic";

// FR-7 `Reschedule`: pick a new time for the same service; the server moves the booking atomically (409 keeps the old).
export function RescheduleForm(props: { appointmentId: string; profileId: string; serviceId: string; clinicTimeZone: string | null; currentStart: string }) {
  const t = useT("booking");
  const router = useRouter();
  const [picked, setPicked] = useState<PickedSlot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ErrorKey | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);

  async function move() {
    if (!picked) return;
    setBusy(true);
    setError(null);
    const res = await send(`/api/appointments/${props.appointmentId}/reschedule`, "POST", { start: picked.start });
    setBusy(false);
    if (res.ok) {
      router.push("/family/appointments?moved=1");
      router.refresh();
      return;
    }
    const code = res.json.code as string;
    const known: ErrorKey[] = ["slot_taken", "slot_unavailable", "too_soon", "too_far", "too_late", "invalid_transition"];
    setError(known.includes(code as ErrorKey) ? (code as ErrorKey) : "generic");
    setPicked(null);
    setRefreshKey((k) => k + 1);
  }

  return (
    <div className="space-y-5">
      {error ? <p role="alert" className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-800">{t(`errors.${error}`)}</p> : null}
      <SlotPicker
        profileId={props.profileId}
        serviceId={props.serviceId}
        clinicTimeZone={props.clinicTimeZone}
        selected={picked}
        onSelect={setPicked}
        refreshKey={refreshKey}
        exclude={props.currentStart}
      />
      <button type="button" className={buttonClass} disabled={!picked || busy} onClick={move}>
        {t("list.moveHere")}
      </button>
    </div>
  );
}
