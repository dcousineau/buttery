import { describe, expect, it } from "vitest";
import { HOST_SCOPED_TRACKING_PARAMS, normalizeSourceUrl } from "./url.ts";

describe("normalizeSourceUrl", () => {
  it("strips NYT's tracking params from a URL taken verbatim from the reference export", () => {
    // Copied out of the sample Paprika export (HTML entities resolved).
    expect(
      normalizeSourceUrl(
        "https://cooking.nytimes.com/recipes/1022924-air-fryer-chicken-parmesan?action=click&module=Collection%20Page%20Recipe%20Card&region=Our%20Best%20Chicken%20Breast%20Recipes&pgType=collection&rank=9",
      ),
    ).toBe("cooking.nytimes.com/recipes/1022924-air-fryer-chicken-parmesan");
    expect(normalizeSourceUrl("https://cooking.nytimes.com/recipes/1019897-chickpea-harissa-soup?smid=ck-recipe-iOS-share#")).toBe(
      "cooking.nytimes.com/recipes/1019897-chickpea-harissa-soup?smid=ck-recipe-iOS-share",
    );
  });

  it("treats http and https as the same recipe", () => {
    expect(normalizeSourceUrl("http://example.com/recipes/cookies")).toBe(normalizeSourceUrl("https://example.com/recipes/cookies"));
  });

  it("strips a leading www. and the default port", () => {
    expect(normalizeSourceUrl("https://www.example.com/cookies")).toBe("example.com/cookies");
    expect(normalizeSourceUrl("https://example.com:443/cookies")).toBe("example.com/cookies");
    expect(normalizeSourceUrl("http://example.com:80/cookies")).toBe("example.com/cookies");
    // A non-default port is part of the resource's identity and survives.
    expect(normalizeSourceUrl("http://example.com:8080/cookies")).toBe("example.com:8080/cookies");
  });

  it("drops the fragment", () => {
    expect(normalizeSourceUrl("https://example.com/cookies#ingredients")).toBe("example.com/cookies");
  });

  it("drops global tracking params, matching utm_ by prefix and the rest case-insensitively", () => {
    expect(
      normalizeSourceUrl(
        "https://example.com/c?utm_source=x&utm_campaign=y&UTM_Medium=z&fbclid=1&gclid=2&dclid=3&msclkid=4&mc_cid=5&mc_eid=6&_ga=7&igshid=8&si=9&ref=a&ref_src=b&ref_source=c",
      ),
    ).toBe("example.com/c");
    expect(normalizeSourceUrl("https://example.com/c?FBCLID=1&keep=yes")).toBe("example.com/c?keep=yes");
  });

  it("sorts surviving params by name then value", () => {
    expect(normalizeSourceUrl("https://example.com/c?b=2&a=zebra&a=apple")).toBe("example.com/c?a=apple&a=zebra&b=2");
    expect(normalizeSourceUrl("https://example.com/c?a=zebra&b=2&a=apple")).toBe(normalizeSourceUrl("https://example.com/c?b=2&a=apple&a=zebra"));
  });

  it("scopes NYT's params to NYT: ?action=print survives elsewhere", () => {
    expect(normalizeSourceUrl("https://example.com/c?action=print")).toBe("example.com/c?action=print");
    expect(normalizeSourceUrl("https://example.com/c?source=archive&module=m&region=r&pgType=p&rank=1")).toBe("example.com/c?module=m&pgType=p&rank=1&region=r&source=archive");
    expect(normalizeSourceUrl("https://cooking.nytimes.com/c?action=print")).toBe("cooking.nytimes.com/c");
    expect(normalizeSourceUrl("https://www.nytimes.com/c?action=print&source=archive")).toBe("nytimes.com/c");
    // Any subdomain, not just the two named ones.
    expect(normalizeSourceUrl("https://some.deep.nytimes.com/c?rank=9&keep=1")).toBe("some.deep.nytimes.com/c?keep=1");
    // Not a subdomain — a suffix lookalike must not match.
    expect(normalizeSourceUrl("https://notnytimes.com/c?action=print")).toBe("notnytimes.com/c?action=print");
  });

  it("exports the host-scope table so it can be asserted on and extended", () => {
    expect(HOST_SCOPED_TRACKING_PARAMS.map((s) => s.host)).toContain("nytimes.com");
  });

  it("decodes unreserved escapes only, keeping reserved delimiters encoded", () => {
    expect(normalizeSourceUrl("https://example.com/a%2Db%7Ec")).toBe("example.com/a-b~c");
    expect(normalizeSourceUrl("https://example.com/%41%31%2E%5F")).toBe("example.com/A1._");
    // /a%2Fb and /a/b are different resources and must not collapse onto one key.
    expect(normalizeSourceUrl("https://example.com/a%2Fb")).toBe("example.com/a%2Fb");
    expect(normalizeSourceUrl("https://example.com/a/b")).toBe("example.com/a/b");
    expect(normalizeSourceUrl("https://example.com/a%2Fb")).not.toBe(normalizeSourceUrl("https://example.com/a/b"));
    // Surviving escapes are uppercased so %2f and %2F land on the same key.
    expect(normalizeSourceUrl("https://example.com/a%2fb")).toBe("example.com/a%2Fb");
  });

  it("collapses repeated slashes and strips a trailing slash, but keeps a bare /", () => {
    expect(normalizeSourceUrl("https://example.com/a//b///c")).toBe("example.com/a/b/c");
    expect(normalizeSourceUrl("https://example.com/cookies/")).toBe("example.com/cookies");
    expect(normalizeSourceUrl("https://example.com/")).toBe("example.com/");
    expect(normalizeSourceUrl("https://example.com")).toBe("example.com/");
  });

  it("returns null for anything that can't identify a web resource", () => {
    expect(normalizeSourceUrl(null)).toBeNull();
    expect(normalizeSourceUrl(undefined)).toBeNull();
    expect(normalizeSourceUrl("")).toBeNull();
    expect(normalizeSourceUrl("   ")).toBeNull();
    expect(normalizeSourceUrl("not a url")).toBeNull();
    expect(normalizeSourceUrl("/relative/path")).toBeNull();
    expect(normalizeSourceUrl("ftp://example.com/c")).toBeNull();
    expect(normalizeSourceUrl("file:///Users/me/recipe.html")).toBeNull();
    expect(normalizeSourceUrl("javascript:alert(1)")).toBeNull();
  });

  it("ignores surrounding whitespace", () => {
    expect(normalizeSourceUrl("  https://example.com/cookies  ")).toBe("example.com/cookies");
  });
});
