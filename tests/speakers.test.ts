import { describe, expect, it } from "vitest";
import {
  SWAP_BLOCKED,
  TRANSCRIBE_FIRST,
  TRANSCRIPTION_RUNNING,
  isManualDecision,
  swapSegments,
  swapSpeakerMap,
  swapSpeakersInTx,
} from "@/lib/speakers";
import { EXTRACTION_RUNNING } from "@/lib/facts";
import type { Segment, SpeakerRole } from "@/lib/types";

const seg = (id: string, speaker: SpeakerRole): Segment => ({
  id,
  speaker,
  speaker_label: id,
  start_sec: 0,
  end_sec: 1,
  text: "x",
});

describe("pure swap rules (FR-6)", () => {
  it("exchanges therapist and parent in the map and keeps other roles", () => {
    expect(swapSpeakerMap({ speaker_0: "therapist", speaker_1: "parent", speaker_2: "unknown" })).toEqual({
      speaker_0: "parent",
      speaker_1: "therapist",
      speaker_2: "unknown",
    });
  });

  it("exchanges every segment speaker and leaves the rest untouched", () => {
    const out = swapSegments([seg("s1", "therapist"), seg("s2", "parent"), seg("s3", "agent")]);
    expect(out.map((s) => s.speaker)).toEqual(["parent", "therapist", "agent"]);
    expect(out.map((s) => s.id)).toEqual(["s1", "s2", "s3"]);
  });

  it("swapping twice restores the original", () => {
    const map = { speaker_0: "therapist", speaker_1: "parent" } as Record<string, SpeakerRole>;
    expect(swapSpeakerMap(swapSpeakerMap(map))).toEqual(map);
  });

  it("a manual decision is an edited item or a confirmed non-voice-note item", () => {
    expect(isManualDecision({ status: "edited", source: "session" })).toBe(true);
    expect(isManualDecision({ status: "edited", source: "therapist_voice" })).toBe(true);
    expect(isManualDecision({ status: "confirmed", source: "session" })).toBe(true);
    expect(isManualDecision({ status: "confirmed", source: "therapist_voice" })).toBe(false);
    expect(isManualDecision({ status: "suggested", source: "session" })).toBe(false);
  });
});

// A fake transaction: records every statement and answers selects with canned rows.
type Row = Record<string, unknown>;
function fakeTx(opts: { recording: Row | null; facts: Row[] }) {
  const log: { sql: string; values: unknown[] }[] = [];
  const tx = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const sql = strings.join("?").replace(/\s+/g, " ").trim();
      log.push({ sql, values });
      if (sql.startsWith("select id, case_id")) return opts.recording ? [opts.recording] : [];
      if (sql.startsWith("select status, source from facts")) return opts.facts;
      if (sql.startsWith("update facts")) return Object.assign([], { count: opts.facts.length });
      return [];
    },
    { json: (v: unknown) => ({ json: v }) },
  );
  return { tx: tx as never, log };
}

const recording = (status: string, extra: Row = {}): Row => ({
  id: "r1",
  case_id: "c1",
  kind: "session",
  status,
  speaker_map: { speaker_0: "therapist", speaker_1: "parent" },
  segments: [seg("s1", "therapist"), seg("s2", "parent")],
  ...extra,
});

const writes = (log: { sql: string; values: unknown[] }[]) => log.filter((l) => /^(update|insert|delete)/.test(l.sql));

describe("swapSpeakersInTx", () => {
  it("locks the recording row before reading facts or writing anything", async () => {
    const { tx, log } = fakeTx({ recording: recording("extracted"), facts: [] });
    await swapSpeakersInTx(tx, "r1");
    expect(log[0].sql).toMatch(/from recordings where id = \? for update$/);
    expect(log[1].sql).toMatch(/from facts .* for update$/);
  });

  it("clears every mapping-dependent value before the swap is saved, in one transaction", async () => {
    const { tx, log } = fakeTx({
      recording: recording("extracted", { red_flags: [{ type: "lost_speech" }] }),
      facts: [
        { status: "suggested", source: "session" },
        { status: "confirmed", source: "therapist_voice" },
      ],
    });
    const result = await swapSpeakersInTx(tx, "r1");
    expect(result).toEqual({
      ok: true,
      data: { speaker_map: { speaker_0: "parent", speaker_1: "therapist" }, segments_count: 2 },
    });

    const [facts, rec, audit] = writes(log);
    for (const column of ["value = null", "ai_value = null", "evidence = null", "confidence = null", "rationale = null"]) {
      expect(facts.sql).toContain(column);
    }
    expect(facts.sql).toContain("confirmed_by = null, confirmed_at = null");
    expect(facts.sql).toContain("source = 'session', status = 'suggested'");
    expect(facts.sql).toContain("instrument = 'ISAA'");
    expect(rec.sql).toContain("red_flags = '[]'::jsonb");
    expect(rec.values[0]).toEqual({ json: { speaker_0: "parent", speaker_1: "therapist" } });
    expect((rec.values[1] as { json: Segment[] }).json.map((s) => s.speaker)).toEqual(["parent", "therapist"]);
    expect(audit.sql).toContain("insert into audit_events");
    expect(audit.sql).toContain("'recording.speakers_swapped', 'recording'");
  });

  it("rejects while extraction is running and writes nothing", async () => {
    const { tx, log } = fakeTx({ recording: recording("extracting"), facts: [] });
    expect(await swapSpeakersInTx(tx, "r1")).toEqual({ ok: false, status: 409, error: EXTRACTION_RUNNING });
    expect(writes(log)).toEqual([]);
  });

  it("rejects while transcription is running and before there is a transcript", async () => {
    for (const [status, error] of [
      ["transcribing", TRANSCRIPTION_RUNNING],
      ["created", TRANSCRIBE_FIRST],
      ["failed", TRANSCRIBE_FIRST],
    ] as const) {
      const { tx, log } = fakeTx({ recording: recording(status), facts: [] });
      expect(await swapSpeakersInTx(tx, "r1")).toEqual({ ok: false, status: 409, error });
      expect(writes(log)).toEqual([]);
    }
  });

  it("rejects after a manual decision and leaves every fact untouched", async () => {
    for (const fact of [
      { status: "edited", source: "session" },
      { status: "edited", source: "therapist_voice" },
      { status: "confirmed", source: "session" },
    ]) {
      const { tx, log } = fakeTx({ recording: recording("extracted"), facts: [{ status: "suggested", source: "session" }, fact] });
      expect(await swapSpeakersInTx(tx, "r1")).toEqual({ ok: false, status: 409, error: SWAP_BLOCKED });
      expect(writes(log)).toEqual([]);
    }
  });

  it("answers 404 for an unknown recording or one that is not a session", async () => {
    for (const rec of [null, recording("extracted", { kind: "intake_call" })]) {
      const { tx, log } = fakeTx({ recording: rec, facts: [] });
      expect(await swapSpeakersInTx(tx, "r1")).toEqual({ ok: false, status: 404, error: "Session not found" });
      expect(writes(log)).toEqual([]);
    }
  });
});
