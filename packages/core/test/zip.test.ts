import { describe, expect, it } from "vitest";
import { text, unzip, zip } from "../src/xlsx/zip";

describe("zip", () => {
  it("round-trips text and binary entries", async () => {
    const big = "row,value\n" + Array.from({ length: 5000 }, (_, i) => `${i},${i * 2}`).join("\n");
    const bytes = await zip([
      ["a.txt", "hello"],
      ["dir/b.xml", big],
      ["c.bin", Uint8Array.from([0, 1, 2, 255])],
    ]);
    expect(bytes.length).toBeLessThan(big.length); // it actually compressed
    const back = await unzip(bytes);
    expect(text(back.get("a.txt"))).toBe("hello");
    expect(text(back.get("dir/b.xml"))).toBe(big);
    expect([...back.get("c.bin")!]).toEqual([0, 1, 2, 255]);
  });

  it("refuses something that isn't a zip", async () => {
    await expect(unzip(new TextEncoder().encode("not a zip at all, sorry"))).rejects.toThrow(/zip/);
  });
});
