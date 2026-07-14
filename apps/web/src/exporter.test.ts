import { describe, expect, it } from "vitest";
import { csvField } from "./exporter";

describe("csvField", () => {
  it("leaves plain values alone", () => {
    expect(csvField("hello")).toBe("hello");
    expect(csvField(42)).toBe("42");
    expect(csvField(null)).toBe("");
  });

  it("quotes values containing commas, quotes or newlines", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField("two\nlines")).toBe('"two\nlines"');
  });
});
