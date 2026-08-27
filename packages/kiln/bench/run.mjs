// Runs the TypeScript benchmark through Vite's SSR loader (no extra deps).
import { createServer } from "vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../..", import.meta.url));
const server = await createServer({ root, logLevel: "error", server: { middlewareMode: true, hmr: false }, appType: "custom", optimizeDeps: { noDiscovery: true } });
try {
  await server.ssrLoadModule("/packages/kiln/bench/tokens.ts");
} finally {
  await server.close();
}
