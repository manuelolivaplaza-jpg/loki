import { spawnSync } from "node:child_process";

/**
 * Build para Capacitor: export estático + sync a android/.
 * Equivale a `next build && npx cap sync android` con BUILD_TARGET=capacitor
 * (así `next.config.ts` usa `output: "export"` + `trailingSlash`).
 */

function run(command, args, env) {
  const result = spawnSync(command, args, {
    shell: true,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

run("npx next build", [], { BUILD_TARGET: "capacitor" });
run("npx cap sync android", [], {});
