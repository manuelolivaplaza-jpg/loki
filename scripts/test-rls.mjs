/**
 * Corrido de los tests de RLS contra el Supabase local.
 *
 * Hace de puente entre npm y `node --test`:
 *   1. lee URL, anon key y service_role key de `supabase status -o env`
 *      (a traves de scripts/supabase.mjs, que habla con el CLI dentro de WSL);
 *   2. pasa las claves por entorno, para que los tests no dependan de
 *      .env.local ni de tener Supabase arrancado a mano;
 *   3. lanza `node --test` con los archivos DE FORMA EXPLICITA y
 *      `--test-concurrency=1`.
 *
 * Nota de Windows: `node --test tests/` no descubre los .mjs (el runner solo
 * reconoce patrones de nombres por defecto), asi que la lista se arma leyendo
 * el directorio.
 *
 * Uso: npm run test:rls
 */

import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";

import { supabaseStatusEnv } from "./supabase.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, "..");
const testDir = path.join(projectRoot, "tests", "rls");

function listTestFiles() {
  if (!existsSync(testDir)) {
    console.error(`[test:rls] no existe ${testDir}`);
    process.exit(1);
  }
  const files = readdirSync(testDir)
    .filter((name) => name.endsWith(".test.mjs"))
    .sort()
    .map((name) => path.join("tests", "rls", name));
  if (files.length === 0) {
    console.error("[test:rls] no hay archivos *.test.mjs en tests/rls");
    process.exit(1);
  }
  return files;
}

let env;
try {
  env = supabaseStatusEnv();
} catch (error) {
  console.error("[test:rls] no se pudo leer `supabase status -o env`:");
  console.error(error instanceof Error ? error.message : error);
  console.error("\nArranca el stack local con: npm run sb:start");
  process.exit(1);
}

const url = env.API_URL ?? "http://127.0.0.1:54321";
const anonKey = env.ANON_KEY ?? env.PUBLISHABLE_KEY;
const serviceKey = env.SERVICE_ROLE_KEY ?? env.SECRET_KEY;

if (!anonKey || !serviceKey) {
  console.error("[test:rls] `supabase status -o env` no devolvio ANON_KEY ni SERVICE_ROLE_KEY.");
  process.exit(1);
}

const files = listTestFiles();
console.log(`[test:rls] Supabase local en ${url}`);
console.log(`[test:rls] ${files.length} archivos de test`);
for (const file of files) console.log(`[test:rls]   · ${file}`);
console.log("");

const child = spawn(
  process.execPath,
  ["--test", "--test-concurrency=1", ...files],
  {
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      LOKI_SUPABASE_URL: url,
      LOKI_SUPABASE_ANON_KEY: anonKey,
      LOKI_SUPABASE_SERVICE_ROLE_KEY: serviceKey,
      // Un id de corrida compartido: los archivos corren en procesos
      // separados, asi que los correos de prueba se generan una sola vez.
      LOKI_TEST_RUN_ID: `${Date.now().toString(36)}${randomBytes(2).toString("hex")}`,
    },
  },
);

child.on("error", (error) => {
  console.error("[test:rls] no se pudo lanzar node --test:", error.message);
  process.exit(1);
});

child.on("close", (code, signal) => {
  if (signal) {
    console.error(`[test:rls] node --test terminado por senal ${signal}`);
    process.exit(1);
  }
  process.exit(code ?? 1);
});
