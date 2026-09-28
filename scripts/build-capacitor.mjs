import { spawn } from "node:child_process";

const child = spawn("next build", [], {
  shell: true,
  stdio: "inherit",
  env: { ...process.env, BUILD_TARGET: "capacitor" },
});

child.on("close", (code) => {
  process.exit(code ?? 1);
});

child.on("error", (error) => {
  console.error(error);
  process.exit(1);
});
