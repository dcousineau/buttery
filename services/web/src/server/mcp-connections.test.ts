import { describe, expect, it } from "vitest";
import { connectionName, isTokenBackedByConsent, safeIconUrl } from "./mcp-connections";

describe("connectionName", () => {
  it("prefers the registered name", () => {
    expect(connectionName({ name: " Claude ", uri: "https://claude.ai", clientId: "x" })).toBe("Claude");
  });
  it("falls back to the site host, then the client id host, then the raw id", () => {
    expect(connectionName({ name: null, uri: "https://claude.ai/about", clientId: "x" })).toBe("claude.ai");
    expect(connectionName({ name: "", uri: null, clientId: "https://app.example.com/meta.json" })).toBe("app.example.com");
    expect(connectionName({ name: null, uri: null, clientId: "abc123" })).toBe("abc123");
  });
});

describe("safeIconUrl", () => {
  it("allows only https", () => {
    expect(safeIconUrl("https://example.com/i.png")).toBe("https://example.com/i.png");
    expect(safeIconUrl("http://example.com/i.png")).toBeNull();
    expect(safeIconUrl("javascript:alert(1)")).toBeNull();
    expect(safeIconUrl("data:image/png;base64,AAAA")).toBeNull();
    expect(safeIconUrl("nope")).toBeNull();
    expect(safeIconUrl(null)).toBeNull();
  });
});

describe("isTokenBackedByConsent", () => {
  const granted = new Date("2026-01-01T00:00:10.500Z");
  const grantedSeconds = Math.floor(granted.getTime() / 1000);

  it("rejects when there is no consent", () => {
    expect(isTokenBackedByConsent(null, grantedSeconds + 5)).toBe(false);
  });
  it("accepts a token issued at or after the consent", () => {
    expect(isTokenBackedByConsent(granted, grantedSeconds)).toBe(true);
    expect(isTokenBackedByConsent(granted, grantedSeconds + 3600)).toBe(true);
  });
  it("rejects a token issued before the current consent (old grant, reconnected later)", () => {
    expect(isTokenBackedByConsent(granted, grantedSeconds - 1)).toBe(false);
  });
  it("rejects a token with no iat", () => {
    expect(isTokenBackedByConsent(granted, undefined)).toBe(false);
  });
});
