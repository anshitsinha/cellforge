// Lets plain Node run the TypeScript sources: extensionless imports resolve
// to .ts files, and .ts files are stripped/transformed with the oxc
// transformer that ships with Vite (rolldown). Used by run.ts:
//   node --import ./bench/acceptance/register.mjs bench/acceptance/run.ts 6000000
import { registerHooks } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { transformSync } from "rolldown/utils";

registerHooks({
  resolve(spec, ctx, next) {
    if ((spec.startsWith(".") || spec.startsWith("/")) && !/\.[cm]?[jt]s$/.test(spec) && ctx.parentURL?.startsWith("file:")) {
      for (const ext of [".ts", "/index.ts"]) {
        const u = new URL(spec + ext, ctx.parentURL);
        if (existsSync(fileURLToPath(u))) return next(u.href, ctx);
      }
    }
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (url.startsWith("file:") && url.endsWith(".ts")) {
      const file = fileURLToPath(url);
      const out = transformSync(file, readFileSync(file, "utf8"), { lang: "ts", sourcemap: false });
      if (out.errors?.length) throw new Error(`${file}: ${out.errors.map((e) => e.message).join("; ")}`);
      return { format: "module", source: out.code, shortCircuit: true };
    }
    return next(url, ctx);
  },
});
