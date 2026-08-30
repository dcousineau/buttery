import { describe, expect, it } from "vitest";
import { toJsonRow, toJsonValue } from "./json.ts";

describe("toJsonValue", () => {
  it("renders a Date as an ISO string", () => {
    expect(toJsonValue(new Date("2026-08-01T10:00:00Z"))).toBe("2026-08-01T10:00:00.000Z");
  });

  it("renders a bigint as a decimal string rather than rounding it", () => {
    // `int8` ids past 2^53 lose precision the moment they become a number.
    expect(toJsonValue(9007199254740993n)).toBe("9007199254740993");
  });

  it("collapses undefined to null", () => {
    expect(toJsonValue(undefined)).toBeNull();
  });

  it("leaves a numeric-as-string alone, so 1.50 does not reprint as 1.5", () => {
    expect(toJsonValue("1.50")).toBe("1.50");
  });

  it("recurses through arrays and objects", () => {
    expect(toJsonValue({ a: [new Date(0), { b: 1n }] })).toEqual({ a: ["1970-01-01T00:00:00.000Z", { b: "1" }] });
  });

  it("summarises binary rather than stringifying it into noise", () => {
    expect(toJsonValue(new Uint8Array([1, 2, 3]))).toBe("<3 bytes>");
  });
});

describe("toJsonRow", () => {
  it("normalises every column of a row", () => {
    expect(toJsonRow({ id: "r1", indexed_at: new Date(0), deleted_at: null, count: 3 })).toEqual({
      id: "r1",
      indexed_at: "1970-01-01T00:00:00.000Z",
      deleted_at: null,
      count: 3,
    });
  });
});
