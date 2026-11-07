/**
 * API test: a request body that fails schema validation gets a plain-language
 * message (never Zod's developer wording) plus machine-readable field paths.
 * Validation runs in `readJson` before any database access, so no DB is needed.
 */
import { describe, expect, it } from "vitest";
import { POST as createOutingRoute } from "@/app/api/outings/route";

interface ErrorBody {
  error: { code: string; message: string; fields?: string[] };
}

function createOutingRequest(body: unknown): Request {
  return new Request("http://localhost:3302/api/outings", {
    method: "POST",
    headers: { host: "localhost:3302", origin: "http://localhost:3302", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("INVALID_INPUT responses", () => {
  it("explain the problem in plain words and list the offending fields", async () => {
    const res = await createOutingRoute(createOutingRequest({ organizerName: 42 }));

    expect(res.status).toBe(400);
    const { error } = (await res.json()) as ErrorBody;
    expect(error.code).toBe("INVALID_INPUT");
    expect(error.message).toBe("Some of the details sent weren't in the expected format. Check what you entered and try again.");
    expect(error.fields).toEqual(expect.arrayContaining(["organizerName", "brief"]));
    expect(error.fields).toHaveLength(2);
    // Zod's developer wording and raw field paths stay out of the human message (paths live in `fields`).
    expect(error.message).not.toMatch(/received|Invalid input|organizerName/i);
  });
});
