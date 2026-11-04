import { describe, expect, it } from "vitest";
import { sortDirection, sortedMessage } from "./sorttext";

describe("sort result line", () => {
  it("names the column and the direction in words", () => {
    expect(sortedMessage(1772, [{ name: "Amount", descending: true, numeric: true }], "en-US")).toBe("Sorted 1,772 rows by Amount, largest first");
    expect(sortedMessage(1, [{ name: "Vendor", descending: false, numeric: false }], "en-US")).toBe("Sorted 1 row by Vendor, A to Z");
  });
  it("lists several keys in order", () => {
    expect(
      sortedMessage(128, [
        { name: "Vendor", descending: false, numeric: false },
        { name: "Date", descending: true, numeric: true },
      ], "en-US"),
    ).toBe("Sorted 128 rows by Vendor (A to Z), then Date (largest first)");
  });
  it("reads as a result, not progress", () => {
    expect(sortDirection({ descending: false, numeric: true })).toBe("smallest first");
    expect(sortDirection({ descending: true, numeric: false })).toBe("Z to A");
    expect(sortedMessage(0, [], "en-US")).toBe("Sorted 0 rows");
  });
});
