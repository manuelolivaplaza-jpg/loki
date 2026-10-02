# Loki Escritorio (compañero de escritorio)

App liviana para Windows (primero) que vive en la bandeja del sistema, arranca
con Windows, se conecta **hacia afuera** a Supabase Realtime y ejecuta los
comandos del catálogo cerrado. Desde el chat (web o Android) ordenas acciones
en tu propio PC y ves el resultado en una tarjeta viva.

Proyecto propio dentro del repo (`desktop/`, su propio `package.json` y
`tsconfig.json`): **no** forma parte del build de Next ni del typecheck/lint
de la raíz.

## Decisión de tecnología

**Tauri 2 + núcleo Node.js TypeScript**, por este orden de motivos:

- El protocolo dispositivo ↔ Loki vive **una sola vez**, en TypeScript
  (`desktop/src/`), el mismo lenguaje de la app y de las Edge Functions: se
  audita fácil y el catálogo se mantiene en sincronía (ver `src/catalog.ts`).
- Tauri 2 aporta solo lo nativo que Node no tiene: **bandeja del sistema,
  autoarranque, actualizaciones y binario chico** (Rust + WebView del sistema,
  ~10 MB frente a ~150 MB de Electron). Nada de Chromium empaquetado.
- El núcleo corre sin privilegios, sin puertos abiertos y sin LLM: una sola
  conexión saliente (WebSocket de Realtime). En desarrollo se corre solo el
  núcleo con Node (`npm run dev`); al empaquetar, Tauri lo lleva como
  **sidecar** (`externalBin`) y el shell Rust solo pinta bandeja/ventana.
- Portable a macOS/Linux sin rehacer el protocolo: los ejecutores ya ramifican
  por `process.platform` (captura, bloqueo, volumen, multimedia) y el shell
  Tauri compila igual en los tres sistemas. Solo cambian el almacén seguro
  (DPAPI → llavero, ver abajo) y el instalador.

Descartados: **Electron** (pesado sin aportar nada: la UI son una ventana
pequeña de vinculación y un menú de bandeja) y **servicio .NET puro** (ata el
protocolo a Windows y duplica el código de Realtime/Storage ya probado en
`@supabase/supabase-js`).

## Cómo funciona (por eventos, sin gastar tokens)

```
Chat/app --orden--> Postgres (device_commands) --Realtime--> PC
PC --latido/resultado--> Postgres (RPC) --Realtime--> tarjeta viva en el chat
```

- En reposo: **una sola conexión** WebSocket suscrita a `device_commands`
  (`device_id=eq.<id>`) y a su propia ficha (`user_devices`). Sin consultas
  periódicas a la API, sin LLM, CPU/RAM mínimos.
- Latido (`device_heartbeat`) **al conectar y con cada comando**: no hay
  polling. El token de corta duración se renueva antes de vencer
  (`scheduleTokenRefresh`).
- Si se cae la red o el PC vuelve de suspensión, reconecta con **backoff**
  (1 s…60 s + jitter) y recoge los pendientes no vencidos
  (`fetchPendingCommands`: `queued`/`delivered` con `expires_at` futuro).
- Al recibir un comando: `device_claim_command` (la base revalida catálogo,
  permisos y confirmación: **doble control**), aviso visible en el PC
  (notificación del sistema), ejecución, `device_report_result` (texto corto
  en la fila; capturas y archivos al bucket `device-results`
  `{owner}/{device}/…`) y línea en el log local rotativo.
- Lo que no entiende o no tiene habilitado se **rechaza con el motivo** (y se
  informa como `error` para que la tarjeta no quede colgada).
- Pausado desde la bandeja: no reclama comandos (se dejan vencer solos, la
  base los marca `expired` en ≤10 min).
- Revocación desde Loki (`revoke_device`): la suscripción a la propia ficha lo
  ve **al instante** (y cualquier RPC que responda "revocado" también); la app
  borra la credencial, avisa y vuelve a la pantalla de vinculación.

## Primera vez: vincular

1. En Loki: Configuración → Mis dispositivos → Vincular un PC (código de 6
   caracteres, un solo uso, 5 min).
2. En el PC: ventana **Vincular con Loki**, se pega el código.
3. La Edge `device-pair` lo canjea y devuelve la credencial del dispositivo
   (email + secreto largo, viaja **una sola vez**). Se guarda cifrada:
   - Windows: **DPAPI** (ámbito CurrentUser) vía PowerShell inbox; en disco
     solo vive el blob cifrado (`%APPDATA%/loki-desktop/vault.dpapi`).
   - macOS/Linux (cuando se porte): archivo modo `0600` como mejor esfuerzo
     hasta integrar el llavero del sistema (pendiente documentado, no bloquea
     Windows).
4. El PC entra con `signInWithPassword` normal y obtiene access tokens de
   corta duración. Nunca ve tu contraseña, ni la `service_role`, ni el
   secreto JWT.

> Nota de protocolo (prompt 15): `device-pair` acepta el canje **solo con el
> código** (probar posesión del código es la autorización: 30 bits de
> entropía, 5 min de vida, un solo uso, rate limit 30 req/min por IP). Si se
> llama con el JWT del dueño, además verifica que el código sea suyo.

## Permisos locales (siempre gana lo más restrictivo)

Bandeja → **Permisos de este PC** (o `loki-desktop perms`):

- Acciones efectivas = habilitadas en Loki **∩** no apagadas aquí
  (`localActionsOff` en `%APPDATA%/loki-desktop/config.json`).
- Carpetas legibles: las de Loki (`readable_dirs`, relativas a la base
  local, por defecto `~/Loki`); el PC nunca sale de ahí (`..`, UNC y enlaces
  simbólicos que escapen se rechazan).
- `arbitrary_exec` exige **doble opt-in**: `allow_arbitrary` en Loki **y**
  `localAllowArbitrary` aquí. Corre con tiempo límite (30 s) y salida
  truncada (4000 caracteres), sin elevar privilegios.
- `run_script` solo corre scripts **registrados aquí con ruta fija**
  (`loki-desktop scripts add <nombre> <ruta>`; `.ps1`/`.cmd`/`.bat`). Loki
  solo manda el **nombre**: nunca viaja contenido de scripts.

## Comportamiento por acción

| Acción | Qué hace este PC |
|---|---|
| `pc_status` | Host, uptime, RAM, CPUs, batería (mejor esfuerzo). Directo. |
| `open_app` | Abre la app por nombre (sin esperar). Con tarjeta en el chat. |
| `open_url` | Revalida `https://` y abre en el navegador. |
| `find_files` | Busca por nombre (máx 20, profundidad 6) solo en carpetas permitidas. |
| `send_file` | Lee (máx 25 MB) dentro de lo permitido y lo sube a Storage. Sensible: se aprueba en el teléfono. |
| `screenshot` | Captura (pantalla virtual en Windows, `screencapture` en macOS, `grim`/`import` en Linux) y la sube. |
| `lock_screen` | Bloquea la sesión. |
| `volume_set` | Nivel 0–100 (`waveOutSetVolume`/`osascript`/`pactl`). En Windows, silenciar = nivel 0 (limitación documentada). |
| `media_control` | Teclas multimedia (Windows `keybd_event`, Linux `playerctl`; macOS no soportado, se rechaza con el motivo). |
| `run_script` | Corre el script registrado por nombre (60 s, salida truncada). Sensible. |
| `arbitrary_exec` | Terminal con límite y truncado, solo con doble opt-in. Sensible. |

Cada ejecución muestra una **notificación del sistema** ("Loki: tomando una
captura pedida desde tu teléfono") y queda en el **log local rotativo**
(`logs/actividad-AAAA-MM-DD.log`, 1 MB × 5) y en **actividad reciente**
(bandeja o `status --json` para el shell).

## Correr en desarrollo (contra Supabase local)

Requisitos: Node 22+, el stack local arriba.

```powershell
# 1. Supabase local + funciones (en la raíz del repo)
npm run sb:start
npm run sb:status      # copia el ANON_KEY
npm run sb:functions   # sirve device-pair y demás

# 2. Núcleo del compañero (en desktop/)
cd desktop
npm install
npm run build
node dist/cli.js link --code XXXXXX --url http://127.0.0.1:54321 --anon <ANON_KEY>
node dist/cli.js run
```

Variables útiles: `LOKI_SUPABASE_URL` y `LOKI_SUPABASE_ANON_KEY` (evitan
pasar `--url`/`--anon`). Comandos: `status`, `perms`, `pause`/`resume`,
`scripts list|add|remove`, `log`, `unlink`. Con `--json` devuelven el estado
para el shell Tauri.

## Empaquetar

```powershell
cd desktop
npm install
npm run build                    # dist/loki-desktop (sidecar)
# Copia dist/cli.js como src-tauri/bin/loki-desktop-<target> (ver Tauri docs de sidecar)
npx tauri build                  # MSI/NSIS por usuario (currentUser, sin admin)
```

Autoarranque: plugin `tauri-plugin-autostart` (registro por usuario en
Windows, LaunchAgent en macOS). El instalador ofrece "iniciar con Windows".

## Pendiente para el lanzamiento (no publicar nada ahora)

- **Firma del ejecutable e instalador**: certificado de firma de código
  (EV recomendado para SmartScreen), firma del `.msi`/`.exe` en CI y
  `assetlinks`/actualizador (Tauri updater con clave privada fuera del repo).
  Sin esto, Windows mostrará avisos al instalar: esperado en desarrollo.
- Llavero en macOS/Linux (hoy archivo `0600`).
- Iconos PNG/ICO generados (`tauri icon assets/icon.png`); hoy solo el SVG
  base estilo Grok (accent `#00B4D8`).

## Límites visibles (los mismos de Loki)

- Ritmo: 10 comandos/min por PC (la tarjeta dice "espera un minuto").
- Confirmaciones sensibles: 5 min. Comandos no entregados: 10 min.
- Resultados: texto corto en la fila; lo grande a Storage (nunca al mensaje
  ni a la push). Sin LLM en el PC: el modelo (barato primero) solo corre en
  la Edge `loki-chat`; aquí todo es código determinista.
