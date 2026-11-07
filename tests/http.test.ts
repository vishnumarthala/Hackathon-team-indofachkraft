import { describe, expect, it } from "vitest";
import { z } from "zod";
import { fail, ok, parseJson } from "@/lib/http";

const schema = z.object({ name: z.string({ error: "Name is required" }), age: z.number().int().min(1, { error: "Too young" }) });

function post(body: string) {
  return new Request("http://localhost/api/x", { method: "POST", body, headers: { "Content-Type": "application/json" } });
}

describe("http helpers", () => {
  it("builds ok and fail responses", async () => {
    const a = ok({ x: 1 }, 201);
    expect(a.status).toBe(201);
    expect(await a.json()).toEqual({ x: 1 });
    const b = fail(404, "Case not found");
    expect(b.status).toBe(404);
    expect(await b.json()).toEqual({ error: "Case not found" });
    expect(await fail(400, "Bad", { a: "b" }).json()).toEqual({ error: "Bad", details: { a: "b" } });
  });

  it("returns parsed data", async () => {
    expect(await parseJson(post('{"name":"a","age":3}'), schema)).toEqual({ data: { name: "a", age: 3 } });
  });

  it("returns 400 with one message per top-level field", async () => {
    const result = await parseJson(post('{"age":0}'), schema);
    if (!("response" in result)) throw new Error("expected a response");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({
      error: "Invalid request",
      details: { name: "Name is required", age: "Too young" },
    });
  });

  it("puts root issues under body", async () => {
    const result = await parseJson(post("[1]"), schema);
    if (!("response" in result)) throw new Error("expected a response");
    expect(Object.keys((await result.response.json()).details)).toEqual(["body"]);
  });

  it("rejects a body that is not JSON", async () => {
    const result = await parseJson(post("not json"), schema);
    if (!("response" in result)) throw new Error("expected a response");
    expect(result.response.status).toBe(400);
    expect(await result.response.json()).toEqual({ error: "Invalid request", details: { body: "Body must be JSON" } });
  });
});
