import { beforeEach, describe, expect, it, vi } from "vitest";

const authMock = vi.hoisted(() => ({ getUser: vi.fn() }));
vi.mock("@/lib/supabase-server", () => ({
  supabaseServer: async () => ({ auth: { getUser: authMock.getUser } }),
}));
vi.mock("@/lib/db", () => ({ supabaseAdmin: vi.fn() }));

import { requireApiUser } from "@/lib/auth";

describe("API authentication", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 when Supabase has no authenticated user", async () => {
    authMock.getUser.mockResolvedValue({ data: { user: null }, error: null });

    const response = await requireApiUser();

    expect(response?.status).toBe(401);
    expect(await response?.json()).toEqual({ error: "Authentication required" });
  });

  it("allows a verified Supabase user", async () => {
    authMock.getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });

    await expect(requireApiUser()).resolves.toBeNull();
  });
});
