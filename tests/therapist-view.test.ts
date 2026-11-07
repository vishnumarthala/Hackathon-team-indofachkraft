import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@elevenlabs/react", () => ({
  ConversationProvider: ({ children }: { children: unknown }) => children,
  useConversation: () => ({ status: "disconnected", isSpeaking: false, startSession: vi.fn(), endSession: vi.fn() }),
}));

import briefFixture from "@/demo/fixtures/gemini/brief.json";
import { SAMPLE_CALL } from "@/components/landing/sampleCall";
import { TherapistView, clock, redFlagLineIndex } from "@/components/landing/TherapistView";
import { BriefSchema } from "@/lib/types";

const brief = BriefSchema.parse(briefFixture);

describe("redFlagLineIndex", () => {
  it("finds the parent lines behind both demo red flags", () => {
    const lost = redFlagLineIndex(brief.red_flags.find((f) => f.type === "lost_speech")!.quote, SAMPLE_CALL);
    const injury = redFlagLineIndex(brief.red_flags.find((f) => f.type === "self_injury")!.quote, SAMPLE_CALL);
    expect(SAMPLE_CALL[lost].role).toBe("parent");
    expect(SAMPLE_CALL[lost].text).toMatch(/stopped talking/);
    expect(SAMPLE_CALL[injury].role).toBe("parent");
    expect(SAMPLE_CALL[injury].text).toMatch(/hits his own head/);
  });

  it("returns -1 for a quote that is not in the call", () => {
    expect(redFlagLineIndex("he rides a bicycle to the park every morning", SAMPLE_CALL)).toBe(-1);
  });

  it("formats clock times", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(95)).toBe("1:35");
  });
});

describe("TherapistView markup", () => {
  const html = renderToStaticMarkup(createElement(TherapistView, { brief }));

  it("shows the case header, the recording and the full transcript", () => {
    expect(html).toContain("Ravi (synthetic)");
    expect(html).toContain("Intake call completed");
    expect(html).toContain('src="/landing/sample-intake-call.mp3"');
    expect((html.match(/<li><button/g) ?? []).length).toBe(SAMPLE_CALL.length);
  });

  it("marks two transcript lines as red flags and offers replay buttons", () => {
    expect((html.match(/>Red flag</g) ?? []).length).toBe(2);
    expect((html.match(/aria-label="Play the moment/g) ?? []).length).toBe(2);
  });

  it("lists every parent answer with Confirm and Edit, and the questions to verify", () => {
    expect((html.match(/>Confirm</g) ?? []).length).toBe(brief.parent_reported.length);
    expect((html.match(/>Edit</g) ?? []).length).toBe(brief.parent_reported.length);
    expect(html).toContain(`0 of ${brief.parent_reported.length} confirmed`);
    for (const q of brief.questions_to_verify) expect(html).toContain(q.replace(/'/g, "&#x27;"));
    expect(html).toContain("This is not a diagnosis.");
  });
});
