/**
 * Lint de `functions/` con la config clásica (`.eslintrc.json`).
 *
 * Este proyecto comparte repositorio con la app, que usa ESLint 9 con
 * `eslint.config.mjs` (flat config) en la raíz. ESLint 8 (el de aquí)
 * detecta ese archivo de la raíz y se pone en modo flat, ignorando el
 * `.eslintrc.json` de esta carpeta. Con `ESLINT_USE_FLAT_CONFIG=false` se
 * fuerza el modo clásico y cada proyecto usa su propia config.
 *
 * equivalente a: ESLINT_USE_FLAT_CONFIG=false eslint src --ext .ts
 * (envuelto en Node para que funcione igual en Windows, sin cross-env).
 */
"use strict";

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const eslintBin = join(__dirname, "..", "node_modules", "eslint", "bin", "eslint.js");
const result = spawnSync(
  process.execPath,
  [eslintBin, "src", "--ext", ".ts"],
  {
    stdio: "inherit",
    env: { ...process.env, ESLINT_USE_FLAT_CONFIG: "false" },
  },
);

process.exit(result.status ?? 1);
