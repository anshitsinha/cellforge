import { describe, expect, it } from "vitest";
import { reviewState, signOffBlock } from "./reviewui";

const sign = { by: "AB", at: 1, logHash: "0", logLength: 0 };

describe("review panel helpers", () => {
  it("says where a sheet stands", () => {
    expect(reviewState({}, 0, 0)).toBe("not started");
    expect(reviewState({ prepared: sign }, 0, 0)).toBe("prepared");
    expect(reviewState({ prepared: sign, reviewed: sign }, 0, 0)).toBe("reviewed");
    expect(reviewState({ prepared: sign, reviewed: sign }, 0, 2)).toBe("changed");
    expect(reviewState({ prepared: sign }, 1, 0)).toBe("changed");
  });

  it("explains why a sign-off has to wait", () => {
    expect(signOffBlock("prepared", {}, 0)).toBeNull();
    expect(signOffBlock("prepared", {}, 2)).toMatch(/2 review notes are still open/);
    expect(signOffBlock("reviewed", {}, 0)).toBe("Sign it off as prepared first.");
    expect(signOffBlock("reviewed", { prepared: sign }, 0)).toBeNull();
  });
});
