# Compañero de escritorio de Loki (protocolo y seguridad)

Etapa 3: desde el chat de Loki (web o teléfono) el usuario ordena acciones en
**su propio PC** y recibe el resultado. El compañero de escritorio (Windows
primero, prompt 15) se conecta **hacia afuera** a Supabase Realtime y espera
comandos: sin puertos abiertos en el PC y sin gastar tokens mientras está
inactivo (principio de arquitectura: todo por eventos).

```
Chat/app --orden--> Postgres (device_commands) --Realtime--> PC
PC --latido/resultado--> Postgres (RPC) --Realtime--> tarjeta viva en el chat
```

## Decisión de autenticación (revisada contra la documentación vigente)

El PC **nunca** usa la contraseña ni la sesión del usuario, ni la
`service_role`, ni el secreto JWT. El mecanismo elegido:

1. El dueño genera un código corto de un solo uso en
   Configuración → Mis dispositivos → Vincular un PC
   (`create_device_pair_code()`, 6 caracteres, vence en 5 min).
2. En el compañero se ingresa el código. La Edge Function `device-pair` lo
   canjea y crea **una identidad Auth propia para el dispositivo**
   (`device_<id>@devices.loki.internal`, clave = secreto largo de 32 bytes).
   En `user_devices` solo vive el hash SHA-256 del secreto.
3. El PC entra con `signInWithPassword` normal y obtiene **access_tokens de
   corta duración** (~1 h) + refresh token. Con ellos escucha por Realtime.
4. La RLS (`my_device_id()`) solo le deja leer **sus propios comandos** y su
   ficha (sin el hash). El resto de tablas le niega todo: no es miembro de
   ningún espacio, así que `is_member()` / `can_access_chat()` dan falso.

¿Por qué así y no otra cosa? Las alternativas evaluadas:

- **service_role o JWT secret en el PC**: descartado (compromete toda la base).
- **Realtime Authorization con canales privados + token propio**: sirve para
  broadcast/presence, pero los comandos necesitan filtrado por fila, y eso lo
  da `postgres_changes` + RLS con un JWT Auth real. No se inventó un sistema
  de tokens paralelo: se reutiliza Auth, que ya rota y expira tokens.
- **La sesión del usuario en el PC**: descartado (el PC vería todos los
  espacios y chats).

Revocar (`revoke_device()`) pone `revoked_at` y **la RLS bloquea al instante**
(aunque al JWT le quede vida, expira en ≤1 h). El latido lo detecta y el
compañero vuelve a la pantalla de vinculación.

## Ciclo de un comando (contrato para el prompt 15)

1. **Pedir** (app, vía Loki o directo): `request_device_command()` valida
   catálogo, parámetros, ritmo (10/min), alcance del chat y permisos; devuelve
   `{id, status, risk}`. Lo `sensible` queda en `pending_confirmation` y mete
   una notificación tipo `device` ("Tu PC necesita tu aprobación", **sin datos
   del PC**).
2. **Recibir** (PC): canal Realtime `postgres_changes` en `device_commands`
   con filtro `device_id=eq.<id>`. Al recibir, latido + 
   `device_claim_command(id)` → devuelve `{ok, action, params, risk}` **desde
   la base** (doble control: el PC revalida riesgo + confirmación registrada;
   no confía en lo que vio la app).
3. **Ejecutar** (PC): solo acciones del catálogo, parámetros ya validados,
   archivos solo dentro de `readable_dirs`, resultados grandes a Storage.
4. **Reportar** (PC): `device_report_result(id, ok, text, path?, mime?)`.
   Texto corto (máx 8000) en la fila; capturas y archivos en el bucket
   `device-results` (`{owner}/{device}/…`), que la app lee con URL firmada.
5. **Ver** (app): tarjeta viva en el chat (`DeviceCommandCard`, meta
   `{kind:"device_command", command_id}`) + historial por PC con filtros +
   auditoría (`device_audit_log`, solo inserción).

Estados: `pending_confirmation → queued → delivered → running → done|error`
(`rejected` por el dueño, `expired` por el barrido). Los no entregados
expiran a los 10 min (`expire_device_commands()` por pg_cron cada minuto, SQL
barato, sin LLM). Las confirmaciones vencen a los 5 min.

RPC del PC (con su JWT): `device_heartbeat`, `device_claim_command`,
`device_report_result`. Si alguna responde "revocado", a vincular de nuevo.

## Catálogo cerrado (no se ejecuta texto libre a ciegas)

| Acción | Riesgo | Camino |
|---|---|---|
| `pc_status` | info | Directo al llegar |
| `open_app`, `open_url` (solo https), `find_files`, `screenshot`, `lock_screen`, `volume_set`, `media_control` | normal | Tarjeta del chat con Confirmar |
| `send_file`, `run_script` (lista del PC), `arbitrary_exec` | sensible | Tarjeta + **aprobación en el teléfono** |

`arbitrary_exec` exige además `allow_arbitrary` explícito en ese PC. Los
parámetros viajan como `{text, dir?, level?, muted?, op?}` (ver
`src/lib/devices/catalog.ts`, espejo en
`supabase/functions/_shared/devices.ts`; la base repite el riesgo en
`device_action_risk()`).

## Lenguaje natural

En el chat: `@mi-pc abre Spotify` o pedírselo a Loki ("toma una captura de mi
PC"). El analizador determinista (`intent.ts`, ambas copias) resuelve lo
simple sin modelo; si no, el modelo barato lo traduce a `run_device_command`
y sale la tarjeta con lo que se va a ejecutar. El LLM nunca corre en el PC.

## Confirmación en el teléfono

Lo sensible genera push tipo `device` a los teléfonos del dueño; al tocarla
se abre `/dispositivos/aprobar?cmd=<id>`: acción en grande, detalle debajo,
Aprobar/Rechazar a la altura del pulgar, háptico. Aunque la orden venga de la
web, lo sensible se aprueba en el teléfono. **Fallback seguro**: en web se
pide la contraseña de nuevo antes de decidir (si la cuenta es solo Google, la
pantalla lo dice y pide usar la app Android).

Por defecto solo se ordena desde el chat privado Loki IA y los DMs del dueño;
en grupos, nadie más que el dueño puede ordenar a su PC (`can_order_device`).
Por dispositivo se ajusta: acciones habilitadas, carpetas legibles, envío de
archivos y alcance de chats.

## Límites visibles

- Ritmo: 10 comandos/min por PC (la tarjeta dice "espera un minuto").
- Confirmaciones: 5 min. Comandos no entregados: 10 min.
- Resultados: texto corto en la fila; lo grande a Storage (nunca al mensaje
  ni a la push).
- Sin clave LLM: Loki IA dice "sin configurar", pero la vía determinista
  (`@mi-pc …` claro) sigue funcionando: es código, no IA.

## Anexo A — Compañero de escritorio (implementación, `desktop/`)

Proyecto propio (`desktop/`, su `package.json`/`tsconfig`, excluido del build
de Next): núcleo Node.js TypeScript + shell Tauri 2 (bandeja, autoarranque,
ventana de vinculación). Detalle en `desktop/README.md`.

- **Conexión**: una sola saliente (WebSocket de Realtime) con dos
  suscripciones: `device_commands` con filtro `device_id=eq.<id>` (INSERT para
  lo nuevo, UPDATE por si un comando vuelve a pendiente) y su propia fila de
  `user_devices` con filtro `id=eq.<id>` (revocación al instante).
- **Sin polling**: latido al conectar y con cada comando; el token corto se
  renueva antes de vencer. Reconnect con backoff (1 s…60 s + jitter) y
  recogida de pendientes no vencidos (`queued`/`delivered`, `expires_at`
  futuro, hasta 20 en orden).
- **Doble control**: el PC reclama con `device_claim_command` (la base
  revalida catálogo, permisos y confirmación) y reporta con
  `device_report_result`. El progreso en vivo es el estado (`running` por
  Realtime → tarjeta `DeviceCommandCard`); lo sensible ya venía aprobado del
  teléfono (`confirm_device_command`, 5 min).
- **Permisos efectivos**: Loki ∩ local, siempre lo más restrictivo. Rutas
  contenidas en la base local (`..`, UNC y symlinks que escapen se
  rechazan). `run_script` resuelve nombre → ruta fija registrada aquí (Loki
  nunca manda contenido). `arbitrary_exec` exige doble opt-in, con timeout
  (30 s) y salida truncada.
- **Visibilidad local**: notificación del sistema antes de cada ejecución,
  log rotativo en el PC y actividad reciente en la bandeja. Pausa = no
  reclamar (los comandos se vencen solos en ≤10 min por `pg_cron`).
- **Vinculación**: `device-pair` acepta el canje solo con el código (la
  posesión del código vigente y sin usar es la autorización); con JWT del
  dueño, además verifica propiedad. La credencial se guarda en DPAPI
  (Windows), nunca en texto plano.
- **Pendiente para el lanzamiento**: firma del ejecutable e instalador (sin
  publicar nada ahora), llavero en macOS/Linux e iconos finales.
