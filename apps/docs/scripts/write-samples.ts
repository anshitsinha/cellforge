/** Writes the tutorial sample files to apps/docs/public/samples/. Run: npm run samples -w @cellforge/docs */
import { mkdirSync, writeFileSync } from "node:fs";
import { sampleFiles } from "./samples.ts";

const dir = new URL("../public/samples/", import.meta.url);
mkdirSync(dir, { recursive: true });
for (const [name, content] of Object.entries(sampleFiles())) {
  writeFileSync(new URL(name, dir), content);
  console.log(`wrote public/samples/${name}`);
}
