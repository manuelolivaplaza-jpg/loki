#!/usr/bin/env node
/**
 * Wrapper del CLI de Supabase para la PC de Manu.
 *
 * En esta maquina NO hay Docker Desktop: el Docker Engine vive dentro de WSL2
 * (Ubuntu) y el CLI de Supabase se ejecuta ahi. Este script decide solo:
 *
 *   - si `docker` esta en el PATH de Windows -> `npx supabase` directo;
 *   - si no                                -> `wsl -d Ubuntu -e bash -lc ...`
 *                                             con la ruta del proyecto
 *                                             convertida a /mnt/c/...
 *
 * Se usa para todos los scripts npm `sb:*` y para `scripts/test-rls.mjs`.
 * No tiene dependencias: solo `node:child_process`.
 */

import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

/** Version fija del CLI, igual que la documentada en .forja/plan-supabase.md. */
const CLI_VERSION = "2.118.0";

/**
 * Servicios que se dejan fuera del stack local: la RAM de WSL (~3.6 GB) es
 * escasa y hay otros contenedores de Manu corriendo. Se arrancan todos los
 * demas (auth, db, realtime, rest, storage, kong, inbucket).
 */
const EXCLUDED_SERVICES = [
  "studio",
  "imgproxy",
  "vector",
  "logflare",
  "supavisor",
  "postgres-meta",
];

/** Raiz del proyecto (este archivo vive en scripts/). */
const projectRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);

function hasDockerOnWindowsPath() {
  const probe =
    process.platform === "win32"
      ? spawnSync("docker", ["--version"], { stdio: "ignore", shell: false })
      : spawnSync("docker", ["--version"], { stdio: "ignore", shell: false });
  return !probe.error && probe.status === 0;
}

/** Convierte `C:\Users\me\loki` en `/mnt/c/Users/me/loki`. */
export function toWslPath(winPath) {
  const normalized = path.resolve(winPath).replace(/\\/g, "/");
  const match = /^([A-Za-z]):\/(.*)$/.exec(normalized);
  if (!match) return normalized;
  const drive = match[1].toLowerCase();
  const rest = match[2];
  return `/mnt/${drive}/${rest}`;
}

/** Comilla un valor para un comando de shell POSIX (single quotes). */
function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function buildWslCommand(args) {
  const cd = shQuote(toWslPath(projectRoot));
  const tail = ["npx", "--yes", `supabase@${CLI_VERSION}`, ...args]
    .map(shQuote)
    .join(" ");
  return `cd ${cd} && ${tail}`;
}

/**
 * Anade los `-x <servicio>` de `start` si el usuario no paso los suyos, para
 * no comerse la RAM de WSL.
 */
function withDefaultExclusions(args) {
  if (args[0] !== "start") return args;
  const alreadyExcluded = args.some((a) => a === "-x" || a === "--exclude");
  if (alreadyExcluded) return args;
  const extras = EXCLUDED_SERVICES.flatMap((service) => ["-x", service]);
  return [args[0], ...extras, ...args.slice(1)];
}

function runNatively(args) {
  return spawn("npx", ["--yes", `supabase@${CLI_VERSION}`, ...args], {
    cwd: projectRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

function runInWsl(args) {
  return spawn("wsl", ["-d", "Ubuntu", "-e", "bash", "-lc", buildWslCommand(args)], {
    cwd: projectRoot,
    stdio: "inherit",
  });
}

/** Ejecuta el CLI y propaga stdout, stderr y exit code. */
export function runSupabase(args) {
  const finalArgs = withDefaultExclusions(args);
  const useWsl = !(process.platform === "win32" && hasDockerOnWindowsPath());
  if (process.env.LOKI_SB_VERBOSE === "1") {
    console.error(
      `[supabase.mjs] ${useWsl ? "via WSL2 Ubuntu" : "nativo"}: supabase ${finalArgs.join(" ")}`,
    );
  }
  return useWsl ? runInWsl(finalArgs) : runNatively(finalArgs);
}

/**
 * Devuelve la salida de `supabase status -o env` como objeto.
 * Se usa en tests/test-rls para leer URL, anon key y service_role key locales.
 */
export function supabaseStatusEnv() {
  const useWsl = !(process.platform === "win32" && hasDockerOnWindowsPath());
  let raw;
  if (useWsl) {
    const result = spawnSync(
      "wsl",
      ["-d", "Ubuntu", "-e", "bash", "-lc", buildWslCommand(["status", "-o", "env"])],
      { cwd: projectRoot, encoding: "utf8" },
    );
    if (result.error) throw result.error;
    raw = result.stdout ?? "";
    if (result.status !== 0) {
      throw new Error(
        `supabase status -o env fallo (${result.status}):\n${raw}\n${result.stderr ?? ""}`,
      );
    }
  } else {
    const result = spawnSync("npx", ["--yes", `supabase@${CLI_VERSION}`, "status", "-o", "env"], {
      cwd: projectRoot,
      encoding: "utf8",
      shell: process.platform === "win32",
    });
    if (result.error) throw result.error;
    raw = result.stdout ?? "";
    if (result.status !== 0) {
      throw new Error(
        `supabase status -o env fallo (${result.status}):\n${raw}\n${result.stderr ?? ""}`,
      );
    }
  }
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?([^"]*)"?$/.exec(line.trim());
    if (match) out[match[1]] = match[2];
  }
  return out;
}

const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isDirectRun) {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("uso: node scripts/supabase.mjs <comando supabase> [args...]");
    console.error(
      "ejemplos: start | stop | status | status -o env | db reset | functions serve",
    );
    process.exit(1);
  }
  const child = runSupabase(args);
  child.on("error", (error) => {
    console.error("[supabase.mjs] no se pudo lanzar el CLI:", error.message);
    process.exit(1);
  });
  child.on("close", (code, signal) => {
    if (signal) {
      console.error(`[supabase.mjs] terminado por senal ${signal}`);
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}
