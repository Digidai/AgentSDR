import { describe, it, expect } from "vitest";
import {
  classifyFallback,
  constantEqual,
  decrypt,
  encrypt,
  emailValid,
  extractJson,
  hashPassword,
  modelText,
  publicUrl,
  render,
  sendingWindow,
  sign,
  verifyPassword,
} from "../src/core";
describe("credential boundaries", () => {
  it("hashes with a per-password salt and verifies without plaintext storage", async () => {
    const a = await hashPassword("correct horse battery staple"),
      b = await hashPassword("correct horse battery staple");
    expect(a).not.toBe(b);
    expect(a).not.toContain("correct horse");
    expect(await verifyPassword("correct horse battery staple", a)).toBe(true);
    expect(await verifyPassword("wrong password", a)).toBe(false);
    expect(await verifyPassword("x", "invalid")).toBe(false);
  });
  it("authenticates encrypted credentials and refuses the wrong key", async () => {
    const encrypted = await encrypt({ api_key: "private-value" }, "secret-one");
    expect(encrypted).not.toContain("private-value");
    expect(await decrypt(encrypted, "secret-one")).toEqual({
      api_key: "private-value",
    });
    await expect(decrypt(encrypted, "secret-two")).rejects.toThrow();
  });
  it("binds unsubscribe signatures to both organization and person", async () => {
    expect(await sign("a:person", "key")).not.toBe(
      await sign("b:person", "key"),
    );
    expect(constantEqual("same", "same")).toBe(true);
    expect(constantEqual("a", "ab")).toBe(false);
  });
});
describe("outreach policy", () => {
  it("handles live Workers AI text, choices and pre-parsed JSON responses", () => {
    expect(modelText({ response: "plain text" })).toBe("plain text");
    expect(
      modelText({
        choices: [{ message: { content: '{"draft":"Hello"}' } }],
        response: { draft: "Hello" },
      }),
    ).toBe('{"draft":"Hello"}');
    expect(modelText({ response: { classification: "interested" } })).toBe(
      '{"classification":"interested"}',
    );
    expect(() => modelText({ response: null })).toThrow();
  });
  it("uses the workspace timezone and excludes the closing hour", () => {
    const org = { timezone: "Asia/Shanghai", start_hour: 9, end_hour: 18 };
    expect(sendingWindow(org, new Date("2026-10-17T00:59:00Z")).allowed).toBe(
      false,
    );
    expect(sendingWindow(org, new Date("2026-10-17T01:00:00Z")).allowed).toBe(
      true,
    );
    expect(sendingWindow(org, new Date("2026-10-17T10:00:00Z")).allowed).toBe(
      false,
    );
    expect(sendingWindow(org, new Date("2026-10-16T23:00:00Z")).day).toBe(
      "2026-10-17",
    );
  });
  it("renders known lead data without executing code or leaving missing fields", () => {
    expect(
      render("Hi {{first_name}} at {{company}}: {{missing}}", {
        name: "Ada Lovelace",
        company: "Engine",
      }),
    ).toBe("Hi Ada at Engine: ");
    expect(render("{{constructor.constructor}}", {})).toBe("");
  });
  it("recognizes opt-out before an AI request", () => {
    expect(classifyFallback("Please REMOVE ME from the list")).toBe(
      "unsubscribe",
    );
    expect(classifyFallback("退订，谢谢")).toBe("unsubscribe");
    expect(classifyFallback("Can we speak next week?")).toBe("needs_review");
  });
  it("rejects local, plaintext, credentialed, numeric and nonstandard targets", () => {
    for (const url of [
      "http://example.com",
      "https://127.0.0.1",
      "https://[::1]",
      "https://example.local",
      "https://localhost",
      "https://a:b@example.com",
      "https://example.com:8080",
    ])
      expect(() => publicUrl(url)).toThrow();
    expect(publicUrl("https://example.com/api").hostname).toBe("example.com");
  });
  it("validates email shape and structured AI responses", () => {
    expect(emailValid("ada@example.com")).toBe(true);
    expect(emailValid("bad@")).toBe(false);
    expect(
      extractJson('```json\n{"classification":"interested"}\n```'),
    ).toEqual({ classification: "interested" });
    expect(() => extractJson("No data")).toThrow();
  });
});
