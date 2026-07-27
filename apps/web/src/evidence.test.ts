import { describe, expect, it } from "vitest";
import { zip } from "@cellforge/core";
import { BlankSource, EditableSource } from "./editable";
import { appendLog, canonical, fingerprint, sha256Hex, verifyLog, type LogEntry } from "./evidence";
import { evidenceFiles, verifyPack } from "./evidencepack";
import { Workbook } from "./workbook";

async function sampleLog(): Promise<LogEntry[]> {
  const log: LogEntry[] = [];
  await appendLog(log, { kind: "open", label: "opened march.csv", at: 1 });
  await appendLog(log, { kind: "run", label: "edit in B2", sheet: "Bank", action: { type: "cells.set", params: { cells: [{ row: 1, col: 1, input: "100" }] } }, at: 2 });
  await appendLog(log, { kind: "undo", label: "edit in B2", at: 3 });
  return log;
}

describe("the evidence log", () => {
  it("chains each entry to the one before", async () => {
    const log = await sampleLog();
    expect(log[0].prev).toBe("0".repeat(64));
    expect(log[1].prev).toBe(log[0].hash);
    expect(await verifyLog(log)).toEqual({ ok: true, head: log[2].hash });
  });

  it("notices a changed, removed or reordered entry", async () => {
    const changed = await sampleLog();
    (changed[1].action!.params as { cells: { input: string }[] }).cells[0].input = "1000";
    expect(await verifyLog(changed)).toMatchObject({ ok: false, brokenAt: 1, reason: expect.stringMatching(/changed/) });

    const removed = await sampleLog();
    removed.splice(1, 1);
    expect(await verifyLog(removed)).toMatchObject({ ok: false, brokenAt: 1 });

    const rehashed = await sampleLog();
    rehashed[0].label = "opened april.csv";
    // even recomputing that entry's hash doesn't help: the next one still points at the old hash
    const { hash: _h, ...rest } = rehashed[0];
    rehashed[0].hash = await sha256Hex(canonical({ i: rest.i, at: rest.at, kind: rest.kind, label: rest.label, sheet: rest.sheet, action: rest.action, prev: rest.prev }));
    expect(await verifyLog(rehashed)).toMatchObject({ ok: false, brokenAt: 1, reason: expect.stringMatching(/follow/) });
  });

  it("hashes keys in a fixed order", () => {
    expect(canonical({ b: 1, a: [1, { d: 2, c: 3 }] })).toBe('{"a":[1,{"c":3,"d":2}],"b":1}');
  });

  it("fingerprints a file with SHA-256", async () => {
    const file = new File(["abc"], "a.txt");
    const fp = await fingerprint(file, "open");
    expect(fp).toMatchObject({ name: "a.txt", size: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", kind: "open" });
  });
});

describe("evidence packs", () => {
  it("hold the workbook, log, inputs and a summary, and verify", async () => {
    const wb = new Workbook({ name: "Bank", source: new EditableSource(new BlankSource(5, 2)) });
    wb.evidence.log = await sampleLog();
    wb.evidence.inputs.push(await fingerprint(new File(["abc"], "march.csv"), "open"));
    const files = await evidenceFiles(wb, wb.sheets[0].id, "March rec");
    expect(files.map(([n]) => n)).toEqual(["SUMMARY.md", "log.json", "inputs.json", "recipes.json", "March rec.cellforge"]);
    const md = files[0][1] as string;
    expect(md).toContain("| march.csv | 3 bytes | `ba7816bf");
    expect(md).toContain("3 entries. Chain intact.");

    const good = await verifyPack(await zip(files));
    expect(good.ok).toBe(true);
    expect(good.evidence.inputs[0].name).toBe("march.csv");

    const tampered = files.map(([n, v]) => [n, n === "log.json" ? (v as string).replace("edit in B2", "edit in B3") : v] as [string, string | Uint8Array]);
    const bad = await verifyPack(await zip(tampered));
    expect(bad.ok).toBe(false);
    expect(bad.message).toMatch(/changed/);
  });
});
