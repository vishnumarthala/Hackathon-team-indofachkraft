import { describe, expect, it } from "vitest";
import { newToken } from "@/lib/tokens";

describe("newToken", () => {
  it("is 43 url-safe characters and unique", () => {
    const tokens = Array.from({ length: 50 }, newToken);
    for (const t of tokens) expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new Set(tokens).size).toBe(50);
  });
});
