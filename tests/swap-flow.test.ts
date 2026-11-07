import { describe, expect, it, vi } from "vitest";
import { reExtract, swapAndExtract, type Call, type CallResult } from "@/components/session/swapFlow";

const r = (status: number, error = ""): CallResult => ({ ok: status >= 200 && status < 400, status, error });

function calls(...results: CallResult[]) {
  const urls: string[] = [];
  const call: Call = async (url, method) => {
    urls.push(`${method} ${url}`);
    return results.shift() ?? r(500, "unexpected call");
  };
  return { call, urls };
}

describe("swapAndExtract (FR-7)", () => {
  it("swaps, then re-runs extraction, then asks for a reload", async () => {
    const { call, urls } = calls(r(200), r(200));
    const onSwapped = vi.fn();
    expect(await swapAndExtract("S", call, onSwapped)).toEqual({ phase: "idle", error: null, reload: true });
    expect(urls).toEqual(["PATCH /api/sessions/S/speakers", "POST /api/sessions/S/extract"]);
    expect(onSwapped).toHaveBeenCalledOnce();
  });

  it("a failed re-extraction stays in the cleared state with the error and a retry, and does not reload", async () => {
    const { call } = calls(r(200), r(502, "Extraction failed"));
    expect(await swapAndExtract("S", call, () => {})).toEqual({ phase: "cleared", error: "Extraction failed", reload: false });
  });

  it("retry only calls extraction (never swaps back) and reloads on success", async () => {
    const { call, urls } = calls(r(502, "Extraction failed"), r(200));
    expect(await reExtract("S", call)).toEqual({ phase: "cleared", error: "Extraction failed", reload: false });
    expect(await reExtract("S", call)).toEqual({ phase: "idle", error: null, reload: true });
    expect(urls).toEqual(["POST /api/sessions/S/extract", "POST /api/sessions/S/extract"]);
  });

  it("409 shows the API error, changes nothing and does not run extraction", async () => {
    const { call, urls } = calls(r(409, "Speakers can't be swapped after items are confirmed"));
    const onSwapped = vi.fn();
    expect(await swapAndExtract("S", call, onSwapped)).toEqual({
      phase: "idle",
      error: "Speakers can't be swapped after items are confirmed",
      reload: false,
    });
    expect(urls).toHaveLength(1);
    expect(onSwapped).not.toHaveBeenCalled();
  });

  it("a lost response (network error or 5xx) reloads so invalidated ratings are never shown as current", async () => {
    for (const res of [r(0, "Network error - try again"), r(500, "Could not swap the speakers")]) {
      const { call } = calls(res);
      expect((await swapAndExtract("S", call, () => {})).reload).toBe(true);
    }
  });
});
