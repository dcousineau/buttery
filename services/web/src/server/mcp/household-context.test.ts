import { describe, expect, it } from "vitest";
import { chooseHousehold } from "./household-context";
import type { HouseholdSummary } from "#/lib/api/types";

const home: HouseholdSummary = { id: "h1", name: "Home", role: "owner", memberCount: 2 };
const cabin: HouseholdSummary = { id: "h2", name: "Cabin", role: "member", memberCount: 4 };

describe("chooseHousehold", () => {
  it("tells the agent to send the user through onboarding when there are no households", () => {
    const choice = chooseHousehold([]);
    expect(choice).toMatchObject({ ok: false });
    expect(!choice.ok && choice.message).toContain("onboarding in person");
  });

  it("uses the only household without being asked", () => {
    expect(chooseHousehold([home])).toEqual({ ok: true, household: home });
  });

  it("makes the agent ask the user when there are several and none is named", () => {
    const choice = chooseHousehold([home, cabin]);
    expect(choice.ok).toBe(false);
    expect(!choice.ok && choice.message).toContain("list_households");
    expect(!choice.ok && choice.message).toContain("rest of this chat");
  });

  it("honors a named household and rejects one the user isn't in", () => {
    expect(chooseHousehold([home, cabin], "h2")).toEqual({ ok: true, household: cabin });
    expect(chooseHousehold([home], "nope")).toMatchObject({ ok: false });
  });
});
