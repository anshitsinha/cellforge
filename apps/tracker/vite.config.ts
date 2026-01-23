import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { type Plugin, defineConfig } from "vite";

const root = resolve(import.meta.dirname, "../..");
const planPath = resolve(root, "docs/PLAN.md");

/**
 * GET /api/state: the plan as written right now plus the latest commits.
 * Dev-server only and read-only; the page polls it, so the tracker follows
 * the work live as steps are ticked and commits land.
 */
function liveState(): Plugin {
  return {
    name: "live-state",
    configureServer(server) {
      server.middlewares.use("/api/state", (_req, res) => {
        let commits: { hash: string; when: number; subject: string }[] = [];
        try {
          const log = execFileSync("git", ["log", "-20", "--format=%h%x09%ct%x09%s"], { cwd: root, encoding: "utf8" });
          commits = log
            .trim()
            .split("\n")
            .filter(Boolean)
            .map((line) => {
              const [hash, when, ...subject] = line.split("\t");
              return { hash, when: Number(when) * 1000, subject: subject.join("\t") };
            });
        } catch {
          // not a git checkout: show the plan without activity
        }
        const body = JSON.stringify({
          plan: readFileSync(planPath, "utf8"),
          planUpdated: statSync(planPath).mtimeMs,
          commits,
          now: Date.now(),
        });
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");
        res.end(body);
      });
    },
  };
}

export default defineConfig({
  plugins: [liveState()],
  server: { port: 5174 },
});
