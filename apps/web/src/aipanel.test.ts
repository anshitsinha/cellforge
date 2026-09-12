import { describe, expect, it } from "vitest";
import { aiBadge } from "./aipanel";
import type { AiStatus } from "./localmodel";

const base: AiStatus = { state: "none", label: "No AI model yet", ready: null, stored: [], download: null, loading: null, error: null };

describe("the Ask AI button's badge", () => {
  it("is grey with a setup hint when there's no model", () => {
    expect(aiBadge(base)).toEqual({ dot: "off", text: "", title: "Ask AI: set up the local AI (runs on this computer)" });
  });

  it("shows download progress", () => {
    const s: AiStatus = { ...base, state: "downloading", label: "Downloading Qwen2.5 1.5B Instruct… 42%", download: { id: "x", name: "Qwen2.5 1.5B Instruct", loaded: 42, total: 100, paused: false, phase: "downloading" } };
    expect(aiBadge(s)).toMatchObject({ dot: "busy", text: "42%" });
  });

  it("names the model when it's ready", () => {
    const s: AiStatus = { ...base, state: "ready", label: "", ready: { name: "Qwen2.5 1.5B Instruct", file: "q.gguf", size: 1, backend: "GPU", tokensPerSecond: 20, gpuFailed: false } };
    expect(aiBadge(s)).toEqual({ dot: "ready", text: "Qwen2.5 1.5B", title: "Local AI ready: Qwen2.5 1.5B Instruct, on the graphics card" });
  });

  it("turns red on an error", () => {
    expect(aiBadge({ ...base, state: "error", error: "Out of memory." })).toMatchObject({ dot: "error", title: "Local AI: Out of memory." });
  });
});
