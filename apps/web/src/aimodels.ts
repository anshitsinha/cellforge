/**
 * The models the AI panel offers to download: small instruct models in the
 * GGUF format that kiln runs (qwen2 architecture; only tensor types kiln
 * supports). Each entry is pinned to one file on Hugging Face with its exact
 * size and SHA-256, so a download is checked byte for byte before it's used.
 *
 * How these were checked (2026-11-16): `curl -sIL <url>` for the size
 * (X-Linked-Size, Content-Length) and hash (X-Linked-ETag), and the GGUF
 * header read with a Range request to list every tensor's type. The 0.5B
 * model is the Q8_0 file because its Q4_K_M file stores most tensors as
 * Q5_0, which kiln doesn't run.
 *
 * Nothing here touches the network. A download only starts when the user
 * presses the Download button, which names the site and the size.
 */
import { TIERS, chooseTier, tierFit, type HardwareInfo, type ModelTier, type TierId } from "@cellforge/kiln";

/** Tensor types as kiln names them (GGML keys). */
export type TensorType = "F32" | "F16" | "BF16" | "Q8_0" | "Q4_0" | "Q4_K" | "Q6_K";

export interface CatalogModel {
  /** the file's name without .gguf; also its name in the browser's storage */
  id: string;
  /** what people see */
  name: string;
  /** Small / Medium / Large */
  size: string;
  params: string;
  arch: "qwen2" | "llama";
  /** the file's quantisation, as its name says */
  quant: string;
  /** every tensor type in the file (read from its header) */
  tensorTypes: readonly TensorType[];
  file: string;
  bytes: number;
  /** lowercase hex SHA-256 of the whole file */
  sha256: string;
  /** direct download (Hugging Face resolve/main) */
  url: string;
  /** the site the download comes from, as the button names it */
  site: string;
  /** the model's page, for people who want to read about it */
  page: string;
  licence: { name: string; url: string; note: string };
  /** one line: what it's good for */
  goodFor: string;
  /** memory the computer should have, in GB */
  minMemoryGB: number;
  /** "optional": fine on the processor; "recommended": slow without a GPU */
  gpu: "optional" | "recommended";
  /** kiln's hardware tier, for the fit check */
  tier: Exclude<TierId, "none">;
}

const HF = "https://huggingface.co";
const repo = (r: string, file: string) => ({ url: `${HF}/${r}/resolve/main/${file}`, page: `${HF}/${r}`, site: "huggingface.co", file });

export const AI_MODELS: readonly CatalogModel[] = [
  {
    id: "qwen2.5-0.5b-instruct-q8_0",
    name: "Qwen2.5 0.5B Instruct",
    size: "Small",
    params: "0.5 billion",
    arch: "qwen2",
    quant: "Q8_0",
    tensorTypes: ["Q8_0", "F32"],
    ...repo("Qwen/Qwen2.5-0.5B-Instruct-GGUF", "qwen2.5-0.5b-instruct-q8_0.gguf"),
    bytes: 675_710_816,
    sha256: "ca59ca7f13d0e15a8cfa77bd17e65d24f6844b554a7b6c12e07a5f89ff76844e",
    licence: { name: "Apache 2.0", url: `${HF}/Qwen/Qwen2.5-0.5B-Instruct-GGUF/blob/main/LICENSE`, note: "Free to use at work." },
    goodFor: "Quick, simple requests and spelling variants. Runs on any computer, even without a graphics card.",
    minMemoryGB: 4,
    gpu: "optional",
    tier: "small",
  },
  {
    id: "qwen2.5-1.5b-instruct-q4_k_m",
    name: "Qwen2.5 1.5B Instruct",
    size: "Medium",
    params: "1.5 billion",
    arch: "qwen2",
    quant: "Q4_K_M",
    tensorTypes: ["Q4_K", "Q6_K", "F32"],
    ...repo("Qwen/Qwen2.5-1.5B-Instruct-GGUF", "qwen2.5-1.5b-instruct-q4_k_m.gguf"),
    bytes: 1_117_320_736,
    sha256: "6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e",
    licence: { name: "Apache 2.0", url: `${HF}/Qwen/Qwen2.5-1.5B-Instruct-GGUF/blob/main/LICENSE`, note: "Free to use at work." },
    goodFor: "The best balance: requests in your own words, explanations and category suggestions. Wants a graphics card.",
    minMemoryGB: 8,
    gpu: "recommended",
    tier: "medium",
  },
  {
    id: "qwen2.5-3b-instruct-q4_k_m",
    name: "Qwen2.5 3B Instruct",
    size: "Large",
    params: "3 billion",
    arch: "qwen2",
    quant: "Q4_K_M",
    tensorTypes: ["Q4_K", "Q6_K", "F32"],
    ...repo("Qwen/Qwen2.5-3B-Instruct-GGUF", "qwen2.5-3b-instruct-q4_k_m.gguf"),
    bytes: 2_104_932_768,
    sha256: "626b4a6678b86442240e33df819e00132d3ba7dddfe1cdc4fbb18e0a9615c62d",
    licence: {
      name: "Qwen Research License",
      url: `${HF}/Qwen/Qwen2.5-3B-Instruct-GGUF/blob/main/LICENSE`,
      note: "For research and non-commercial use; read the licence before using it for client work.",
    },
    goodFor: "The most capable answers, for longer or trickier requests. Needs a good graphics card and 16 GB of memory.",
    minMemoryGB: 16,
    gpu: "recommended",
    tier: "large",
  },
];

export const modelById = (id: string): CatalogModel | undefined => AI_MODELS.find((m) => m.id === id);
export const modelByFile = (file: string): CatalogModel | undefined => AI_MODELS.find((m) => m.file === file);

/** kiln's tier for a catalog model, with the real file size for the storage check. */
export function tierOf(m: CatalogModel): ModelTier {
  const t = TIERS.find((x) => x.id === m.tier)!;
  return { ...t, fileMB: Math.ceil(m.bytes / 2 ** 20) };
}

export interface ModelFit {
  fits: boolean;
  /** why it doesn't fit, in plain words */
  reasons: string[];
}

/** Does this computer run the model well? (kiln's tier check, worded for people) */
export function modelFit(hw: HardwareInfo, m: CatalogModel): ModelFit {
  const r = tierFit(hw, tierOf(m));
  return {
    fits: r.fits,
    reasons: r.reasons.map((x) =>
      x === "needs WebGPU"
        ? "needs a graphics card the browser can use (it would run on the processor, very slowly)"
        : x.startsWith("GPU storage")
          ? `the graphics card is too small for it (${x.replace(/^GPU storage buffers are limited to /, "")} per block)`
          : x.replace(/^needs (\d+) MB of storage$/, (_, mb) => `needs ${formatBytes(Number(mb) * 2 ** 20)} of free browser storage`),
    ),
  };
}

/**
 * The model to suggest: the largest one that fits, but not past Medium. The
 * Large model is offered, never pushed: it's a 2 GB download and its licence
 * limits commercial use.
 */
export function recommendModel(hw: HardwareInfo, models: readonly CatalogModel[] = AI_MODELS): CatalogModel {
  const capped = models.filter((m) => m.tier !== "large");
  const best = chooseTier(hw, capped.map(tierOf));
  return capped.find((m) => m.tier === best.id) ?? capped[0] ?? models[0];
}

/** 675710816 -> "676 MB", 2104932768 -> "2.1 GB" */
export function formatBytes(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(n >= 1e10 ? 0 : 1)} GB`;
  if (n >= 1e6) return `${Math.round(n / 1e6)} MB`;
  if (n >= 1e3) return `${Math.round(n / 1e3)} KB`;
  return `${n} bytes`;
}

/** What this computer has, in one plain line. */
export function describeHardware(hw: HardwareInfo): string {
  const gpu = hw.webgpu && !hw.webgpu.isFallbackAdapter;
  const mem = hw.deviceMemoryGB === null ? null : hw.deviceMemoryGB >= 8 ? "8 GB or more memory" : `${hw.deviceMemoryGB} GB memory`;
  const parts = [
    mem,
    `${hw.cores} processor core${hw.cores === 1 ? "" : "s"}`,
    gpu ? `a graphics card the browser can use${hw.webgpu!.vendor ? ` (${hw.webgpu!.vendor})` : ""}` : "no graphics card the browser can use",
    hw.storageAvailableBytes !== null ? `${formatBytes(hw.storageAvailableBytes)} free for this site` : null,
  ];
  return parts.filter(Boolean).join(" · ");
}
