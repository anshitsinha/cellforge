/**
 * The local AI model: a .gguf file the user picks from their disk, kept in
 * the browser's private storage so it's there next time, and run on this
 * computer by kiln. Nothing is downloaded and nothing is sent anywhere.
 */
import { detectHardware, Kiln, OpfsStorage, type ModelStorage } from "@cellforge/kiln";

export interface LoadedModel {
  name: string;
  size: number;
  kiln: Kiln;
}

let current: LoadedModel | null = null;
let loading: Promise<LoadedModel | null> | null = null;

export const loadedModel = (): LoadedModel | null => current;

function storage(): ModelStorage | null {
  return OpfsStorage.available() ? new OpfsStorage("kiln-models") : null;
}

/** Keep a picked model file (streamed, so a 1 GB file isn't held twice) and load it. */
export async function installModel(file: File, status: (t: string) => void): Promise<LoadedModel> {
  if (!/\.gguf$/i.test(file.name)) throw new Error("Pick a .gguf model file.");
  const store = storage();
  if (store) {
    status(`Keeping ${file.name} in this browser…`);
    for (const old of await store.list()) await store.remove(old);
    const w = await store.openWriter(file.name);
    const reader = file.stream().getReader();
    let done = 0;
    for (;;) {
      const { value, done: end } = await reader.read();
      if (end) break;
      await w.write(value);
      done += value.length;
      status(`Keeping ${file.name} in this browser… ${Math.round((done / file.size) * 100)}%`);
    }
    await w.close();
  }
  status(`Loading ${file.name}…`);
  const kiln = await Kiln.load(new Uint8Array(await file.arrayBuffer()));
  current = { name: file.name, size: file.size, kiln };
  return current;
}

/** The model kept from last time, loaded when first needed. */
export function restoreModel(): Promise<LoadedModel | null> {
  loading ??= (async () => {
    const store = storage();
    if (!store) return null;
    const [name] = await store.list();
    if (!name) return null;
    const bytes = await store.readAll(name);
    if (!bytes) return null;
    current = { name, size: bytes.length, kiln: await Kiln.load(bytes) };
    return current;
  })().catch(() => null);
  return loading;
}

/** Forget the model (and its stored copy). */
export async function removeModel(): Promise<void> {
  const store = storage();
  if (store) for (const n of await store.list()) await store.remove(n);
  current = null;
  loading = null;
}

/** A model file to pick. */
export function pickModelFile(): Promise<File | null> {
  return new Promise((resolve) => {
    const input = Object.assign(document.createElement("input"), { type: "file", accept: ".gguf" });
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null));
    input.addEventListener("cancel", () => resolve(null));
    input.click();
  });
}

/** What this computer can run, in plain words. */
export async function hardwareSummary(): Promise<string> {
  try {
    const hw = await detectHardware();
    const parts = [`${hw.cores ?? "?"} CPU cores`, hw.deviceMemoryGB ? `${hw.deviceMemoryGB} GB memory` : null, hw.webgpu ? "a GPU the browser can use" : "no GPU the browser can use (models run on the CPU, slowly)"];
    return parts.filter(Boolean).join(", ");
  } catch {
    return "";
  }
}
