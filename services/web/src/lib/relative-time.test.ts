import { describe, expect, it } from "vitest";
import { relativeTimeFromNow } from "./relative-time";

const now = new Date("2026-06-15T12:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);

describe("relativeTimeFromNow", () => {
  it("reads just now under a minute and for future times", () => {
    expect(relativeTimeFromNow(ago(20), now, "en")).toBe("just now");
    expect(relativeTimeFromNow(ago(-500), now, "en")).toBe("just now");
  });
  it("picks the largest whole unit", () => {
    expect(relativeTimeFromNow(ago(5 * 60), now, "en")).toBe("5 minutes ago");
    expect(relativeTimeFromNow(ago(3 * 3600), now, "en")).toBe("3 hours ago");
    expect(relativeTimeFromNow(ago(2 * 86400), now, "en")).toBe("2 days ago");
    expect(relativeTimeFromNow(ago(14 * 86400), now, "en")).toBe("2 weeks ago");
  });
});
