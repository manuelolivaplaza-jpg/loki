# Agentes personales de Loki (contrato y seguridad)

Etapa 2: capa genérica de "conectores de agentes" (prompt 12) conectada al
chat (@menciones) y a cada proveedor (prompt 13: `generic_webhook` de
referencia + `grokbot`, `hermes` y `a2a` configurables, `agent-task`,
tarjeta en vivo, mensaje `agent`, confirmación de acciones y push tipo
`agent`).

## Idea central

Cada miembro de un espacio puede conectar **su propio agente de IA personal**
(un bot de Grok Bot, Hermes Agent u otro) e invocarlo desde el chat de Loki
con una mención como `@mi-bot`. Loki habla con todos los agentes con **un
solo contrato propio**; cada proveedor tiene un **adaptador** (en las Edge
Functions) que traduce ese contrato a lo que el proveedor entiende.

```
Loki --tarea--> [adaptador generic_webhook|grokbot|hermes|a2a] --proveedor--> agente
Loki <--eventos-- agent-callback <--agente-------------------------------------
```

Principio de arquitectura (como todo en Loki): nada queda escuchando ni
consultando 24/7. Un `insert` en `agent_runs` despierta a `agent-dispatch`
por `pg_net`; el agente responde a `agent-callback`; todo vuelve a dormir.
`pg_cron` solo hace SQL barato (`expire_agent_runs()` cada 5 min).

## Tarea saliente (Loki → agente)

El webhook solo lleva lo mínimo (menos de 1 KB, sin datos del chat):

```json
{ "type": "loki.agent_task", "v": 1, "run_id": "<uuid>", "run_token": "<secreto>", "attempt": 0 }
```

La tarea completa (la que el agente baja con el token, prompt 13:
`agent-task`) contiene:

| Campo | Qué es |
|---|---|
| `run_id` | Id de la ejecución (`agent_runs.id`). Auditoría de punta a punta. |
| `connection_id`, `handle` | Qué agente se invocó (`@handle`). |
| `space` `{id, name}`, `chat` `{id, name}` | Dónde se pidió. |
| `requested_by` | Nombre visible de quien la pidió. |
| `instruction` | Texto de la orden (máx. 4000 caracteres). |
| `context_messages` | Mensajes recientes del chat, **solo si el grant lo autoriza**, recortados (`[{author, text, at}]`, tope ~2000 caracteres). Puede venir vacío. Nunca DMs salvo invocación en ese DM con permiso. |
| `history` | Preguntas (`needs_input`) y respuestas previas de esta ejecución. |
| `allowed_actions` | Lo que puede **proponer** (`create_task`, `create_event`, `create_reminder`, `add_list_items`). Proponer ≠ ejecutar: lo ejecuta el usuario con su JWT en la tarjeta de confirmación. |
| `limits` | `{max_events: 30, result_chars: 16384, max_links: 10}`. |
| `deadline_at` | Fecha límite ISO (default 15 min). Pasada, la ejecución expira. |

Equivalencia A2A: `run_id` = `taskId`, `status` = `TaskStatus.state`,
`instruction` + `context_messages` = `Message` con `parts`, el resultado =
`Artifact`. Ver el mapa abajo.

## Eventos entrantes (agente → Loki)

`POST` a `agent-callback` con `Bearer <run_token>` (y `X-Loki-Token` si la
conexión tiene token entrante). Cuerpo:

```json
{ "run_id": "<uuid>", "event_id": "<uuid del agente>", "type": "progress", "text": "Revisando el presupuesto…", "percent": 40 }
```

| `type` | Uso |
|---|---|
| `progress` | Texto corto + `percent` opcional. Máx. 1 cada 20 s. |
| `needs_input` | Pregunta de aclaración o confirmación (`question`). Pausa la ejecución hasta la respuesta. |
| `result` | Final: `text` (Markdown simple, máx. 16 KB), `links` (máx. 10, solo `https`), `proposed_actions` (máx. 10, solo tipos de `allowed_actions`). |
| `error` | Fallo con `text` legible (sin datos sensibles). |

Respuestas del callback: `200 {ok:true}` · `200 {duplicate:true}` (mismo
`event_id`, no duplica) · `409 {status}` (terminal o cancelada: el agente se
detiene) · `401` (token inválido) · `410` (token vencido) · `429` en español
(demasiados eventos o demasiado rápido).

## Estados

```
queued → dispatched → running → needs_input → done | error | cancelled | expired
```

| Estado | Significa |
|---|---|
| `queued` | Creada, esperando despacho. |
| `dispatched` | El proveedor aceptó el pedido (HTTP 2xx). |
| `running` | El agente reportó progreso o bajó la tarea (despertó de verdad). |
| `needs_input` | Pregunta al usuario; espera respuesta. |
| `done` | Resultado final guardado. |
| `error` | Fallo (del agente o del despacho), con mensaje humano. |
| `cancelled` | Cancelada por quien la pidió o el dueño (el agente lo sabe en su próximo callback: `409`). |
| `expired` | Pasó el `deadline_at` (barrido SQL). |

`kind` distingue `task` (mención en el chat, prompt 13) de `ping` (botón
"Probar conexión": solo el dueño, con marcas en vivo `dispatched` →
`running` → `done`).

## Datos

| Tabla | Clave |
|---|---|
| `agent_connections` | Dueño, proveedor (`generic_webhook`, `grokbot`, `hermes`, `a2a`), `name`, `handle` (único por espacio habilitado, sin chocar con miembros ni `@Loki`; ver `validate_agent_handle`), `config` (URL de disparo en claro, editable), `secret_enc` (cifrado, solo Edge), `inbound_token_hash` (solo hash, solo Edge), `status`, `last_used_at`. |
| `agent_space_grants` | Por espacio: `enabled` + `admin_disabled`, `allowed_callers` (`owner_only` por defecto, `space_members`, `listed` + `allowed_user_ids`), `allow_context` + `context_messages` (0–50), `allow_dm_context` (default no), `allow_publish`, `allow_propose_actions`, `daily_limit` (default 20). |
| `agent_runs` | Ejecución + auditoría (`requested_by`). `run_token_hash` solo Edge. `idempotency_key` única (una mención no despierta dos veces). |
| `agent_run_events` | Historial (`seq` único por run, `client_event_id` único por run). En Realtime. |

Secretos: `secret_enc` e `inbound_token_hash` tienen `REVOKE` a nivel de
columna para `authenticated`. El cliente usa **listas explícitas de columnas
seguras, nunca `select *`** sobre `agent_connections` ni `agent_runs`
(ver `src/lib/data/agents.ts`). El token entrante en claro se muestra **una
sola vez** al generarlo; regenerarlo invalida el anterior. Pausar invalida
los tokens vivos.

Gobernanza: los admins del espacio desactivan cualquier agente en su espacio
(`set_agent_grant_admin_disabled`) sin ver secretos ni reconfigurarlo.
Cancelación: quien pidió o el dueño (`request_agent_run_cancel`).

## Seguridad (resumen)

- Toda llamada saliente sale de Edge Functions, nunca del navegador. La URL
  de disparo se valida (`https`, sin hosts internos salvo
  `AGENT_ALLOW_PRIVATE=true` en desarrollo).
- Token por ejecución: 32 bytes aleatorios, solo su hash SHA-256 en la base,
  atado a ese `run_id`, vence en `deadline + 10 min`, se invalida al terminar.
  Comparación en tiempo constante.
- Segundo factor opcional: si la conexión tiene token entrante, el callback
  exige además `X-Loki-Token`.
- Contexto mínimo: nada de DMs salvo invocación ahí con permiso. El agente
  nunca escribe datos de Loki directo; todo lo propuesto pasa por la tarjeta
  de confirmación con el JWT de quien confirma. Contenido de terceros como
  texto (safe-text), nunca se ejecuta.
- Límites visibles: tope diario por grant y espacio, 30 eventos/ejecución,
  60 req/min por conexión en el callback.
- Auditoría: cada ejecución guarda quién la pidió, cuándo y qué devolvió.

## Qué datos ve el agente (texto para la UI)

> Tu agente ve **solo** lo que le mandas en cada pedido: tu instrucción y,
> si lo activas, los últimos mensajes del chat (tú eliges cuántos). Nunca ve
> otros chats ni tus DMs, salvo que lo invoques dentro de ese DM y lo
> permitas. El agente corre con **tu** plan del proveedor y es **tu**
> responsabilidad: lo que haga fuera de Loki lo pagas tú.

## Mapa con estándares abiertos

Diseñado para no chocar con ellos; antes de fijar la v1 de cada adaptador,
revisar la spec vigente (cambian rápido).

| Loki | A2A (Agent2Agent) | Notas |
|---|---|---|
| `agent_runs.id` | `Task.id` (`taskId`) | Id estable de la tarea. |
| `status` (`queued`…`expired`) | `TaskStatus.state` (`submitted`, `working`, `input-required`, `completed`, `failed`, `canceled`…) | Loki usa el subconjunto que el chat necesita; el adaptador `a2a` traduce ambos sentidos. |
| `instruction` + `context_messages` | `Message` con `parts` (`TextPart`) | Entrada de la tarea. |
| `needs_input` + `history` | `input-required` + mensajes previos | Continuaciones. |
| `result.text` + `links` | `Artifact` con `parts` | Salida de la tarea. |
| `proposed_actions` | (futuro) herramientas MCP | Ver abajo. |
| `409 {status}` | cancelación / `canceled` | Detener al agente. |

| Loki | MCP (Model Context Protocol) | Notas |
|---|---|---|
| `proposed_actions[]` `{type, title, due_at, notes, items}` | `tools/call` `{name, arguments}` | Mismo vocabulario a propósito: cuando Loki exponga sus acciones como Tools (`tools/list`), los agentes podrán llamarlas directo. |
| `context_messages` | `resources/read` | Hoy el contexto lo recorta Loki; mañana el agente podría leer recursos con permiso. |

## Probar a mano (genérico)

1. `npm run sb:start` y `npm run sb:functions` (con `AGENT_TOKEN_KEY` y
   `AGENT_DISPATCH_KEY` en `supabase/functions/.env`, y `loki.agent_dispatch_url`
   / `loki.agent_dispatch_key` apuntando a la Edge local).
2. Configuración → Mis agentes → Conectar agente → `generic_webhook`, con
   una URL de prueba (p. ej. un webhook temporal https).
3. "Probar conexión": la tarjeta pasa `queued` → `dispatched`; el receptor
   devuelve `{event_id, type:"result", text:"…"}` a `agent-callback` con el
   `run_token` y la tarjeta muestra `done`.
4. Regenerar el token entrante invalida el anterior (el callback viejo da 401).
5. Pausar cancela lo encolado; un admin desactiva el grant y el despacho falla
   con mensaje claro.

## Invocar desde el chat (prompt 13)

Escribe `@mi-bot revisa el presupuesto adjunto` en cualquier chat del espacio:

1. El menú @ trae los agentes habilitados que puedes invocar, con distintivo
   de bot y dueño (`mi-bot · de Manu`). El composer resuelve `@handle` a
   `agent:<connectionId>` (ver `src/lib/chat/mentions.ts`).
2. Al enviar se inserta el mensaje normal y una fila `agent_runs` (queued,
   `idempotency_key = msg:<messageId>:<connectionId>`). El trigger
   `notify_agent_dispatch` despierta a `agent-dispatch` por `pg_net`.
3. La tarjeta bajo el mensaje muestra `mi-bot está trabajando…` con los
   eventos en vivo (Realtime sobre `agent_run_events`), Cancelar y, al
   terminar, el resultado con safe-text + enlaces + acciones propuestas para
   confirmar (el agente nunca escribe directo en Loki).
4. Si pide aclaración (`needs_input`), responde en el hilo: viaja como
   continuación (`agent_continue_run` → `history` → redespacho).
5. Si no responde antes del `deadline_at`, `expire_agent_runs()` (pg_cron,
   SQL barato) marca `expired` y avisa en el chat + notificación.
6. Los demás ven el resultado solo si el grant permite publicar
   (`allow_publish`); si no, es privado (tarjeta + notificación solo para
   quien invocó y el dueño).

## Adaptadores (todo configurable desde la conexión)

Nada hardcodeado: cada conexión guarda `config.dispatch_url`,
`config.headers` (extras), `config.cancel_url` (opcional) y, según el
proveedor, `config.mode` / campos propios. Estado de verificación
(02-10-2026): sin acceso a documentación oficial vigente desde este entorno
(la búsqueda web no respondió), así que ningún adaptador inventa endpoints
del proveedor: todo sale de la config editable por el dueño.

| Proveedor | Qué manda | Qué se configura | Qué verificar en la docs oficial |
|---|---|---|---|
| `generic_webhook` (referencia) | POST mínimo firmado `{type, v, run_id, run_token, attempt, callback_url?, task_url?}` + `X-Loki-Signature` (HMAC-SHA256 de `<timestamp>.<cuerpo>`) + `X-Loki-Timestamp` + Bearer por compatibilidad | `dispatch_url`, secreto saliente, `headers` extras | Nada: es el contrato propio (ver ejemplo mínimo abajo) |
| `grokbot` | POST con la tarea + `callback_url` + `task_url` + `run_token` en el cuerpo (ver `grokbotDispatchBody`) | `dispatch_url` (webhook de la rutina), secreto opcional (firma igual), `headers` extras | Si Grok Bot ofrece canal oficial de retorno/estado, úsalo además del fallback. Fallback vigente: la rutina hace POST a `callback_url` con el `run_token` (las instrucciones de la rutina deben decirlo). No verificado: revisa su docs de rutinas/webhooks antes de producción |
| `hermes` | `config.mode="a2a"` → camino A2A; si no, webhook genérico | `dispatch_url`, `mode`, secreto, `headers` | Qué protocolo expone Hermes (webhook propio o A2A), nombres de campos, firma esperada y canal de estado. Anota aquí lo que encuentres antes de usarlo en producción |
| `a2a` | `tasks/send` (JSON-RPC) con `id = run_id`, `message.parts` (instrucción + contexto) y `metadata` de retorno (`loki_run_id`, `loki_callback_url`, `loki_run_token`, `loki_deadline_at`) | `dispatch_url` (endpoint de tareas del agente), `headers` (auth del agente), `mode` si viene de hermes | Versión de la spec A2A vigente, método exacto (`tasks/send` vs `tasks/sendSubscribe`), formato de `parts` y de `TaskStatus`/`Artifact`. El retorno viaja por `agent-callback` salvo que configures callback A2A propio |

### Ejemplo mínimo: conectar tu propio agente (webhook genérico)

1. Recibes el POST en tu `dispatch_url` (verifica la firma):

```js
import { createHmac, timingSafeEqual } from "node:crypto";

function verifica(req, secreto) {
  const stamp = req.headers["x-loki-timestamp"] ?? "";
  const firma = req.headers["x-loki-signature"] ?? "";
  const esperada = createHmac("sha256", secreto)
    .update(`${stamp}.${JSON.stringify(req.body)}`)
    .digest("hex");
  return firma.length === esperada.length &&
    timingSafeEqual(Buffer.from(firma), Buffer.from(esperada));
}
// body: { type:"loki.agent_task", v:1, run_id, run_token, attempt,
//         callback_url?, task_url? }
```

2. Baja la tarea completa (instrucción + contexto permitido + límites):

```bash
curl "$TASK_URL?run_id=<run_id>" -H "Authorization: Bearer <run_token>"
# → { task: { run_id, handle, instruction, context_messages, history,
#             allowed_actions, limits, deadline_at } }
```

3. Reporta progreso y resultado (firma: solo el `run_token` + `event_id`
   único por evento; repetido → `200 {duplicate:true}`):

```bash
curl "$CALLBACK_URL" -X POST \
  -H "Authorization: Bearer <run_token>" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"<run_id>","event_id":"<uuid>","type":"progress","text":"Revisando…","percent":40}'

curl "$CALLBACK_URL" -X POST \
  -H "Authorization: Bearer <run_token>" \
  -H "Content-Type: application/json" \
  -d '{"run_id":"<run_id>","event_id":"<uuid>","type":"result","text":"Listo: …",
       "links":[{"title":"…","url":"https://…"}],
       "proposed_actions":[{"type":"create_task","title":"…"}]}'
# Tipos: progress | needs_input (con "question") | result | error.
# Respuestas: 200 {ok} · 200 {duplicate} · 409 {status} (detente) ·
# 401 (token inválido) · 410 (vencido) · 429 en español (baja el ritmo).
```

4. Para rutinas tipo Grok Bot, las instrucciones de la rutina deben decir:
   "al terminar haz POST a `callback_url` con `run_token` como Bearer y el
   evento `result`".

## Costo, límites y seguridad
- Invocar no gasta tokens de Loki (armado de contexto = código). Solo cuesta
  cuota si pides un resumen del resultado con el modelo barato (bajo demanda,
  `poll_summary`/`day_highlights` style). Visible en Configuración → Uso de
  IA: por agente (`usado/límite` hoy), por usuario (30/día) y por espacio
  (100/día), además del `daily_limit` del grant.
- Anti-bucles: la instrucción pierde las `@menciones` a otros agentes y las
  continuaciones también; un mensaje `agent` nunca dispara ejecuciones.
- `agent-callback` valida token (hash, tiempo constante, vigencia),
  `event_id` idempotente, tipos y tamaños, rate limit (60/min por conexión,
  progreso 1/20 s, 30 eventos) y nunca ejecuta el contenido (texto de un
  tercero: SafeText, solo enlaces http/https). La URL saliente bloquea
  localhost/redes privadas salvo `AGENT_ALLOW_PRIVATE=true` (desarrollo).
- Cancelar marca `cancelled` e intenta POST best-effort a `config.cancel_url`
  si existe; si no, el agente lo sabe en su próximo callback (`409`).

## Web y móvil

- El @ con agentes usa el mismo menú del composer (encima del teclado: el
  composer ya se eleva con `window.visualViewport`), con flechas + Enter en
  escritorio y toque en Android. Sin resultados, el menú se cierra.
- La tarjeta es compacta en móvil (último evento + "Ver progreso" colapsable)
  y extendida en escritorio (línea de tiempo con `· línea de tiempo` y más
  alto). El hilo (`thread-panel.tsx`) es hoja inferior en móvil y drawer de
  420 px en escritorio; las tarjetas también viven bajo el padre y las
  respuestas ahí.
- Sin gestos nuevos que aprender: Cancelar/Reintentar/Crear son botones ≥44 px
  (táctil y click), Enter confirma y Escape cancela en la tarjeta de Loki.
- Push nativo y web ya cableados: la notificación tipo `agent` llega aunque la
  app esté cerrada y abre el chat en el mensaje (`?msg=`).
