# Agentes personales de Loki (contrato y seguridad)

Etapa 2, prompt 12: capa genérica de "conectores de agentes". El prompt 13 la
conecta al chat (@menciones) y a cada proveedor (Grok Bot, Hermes, A2A).

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

## Lo que falta (prompt 13)

Menciones `@handle` en el chat (disparan `agent_runs` con `idempotency_key`),
tarjeta de ejecución en vivo, mensaje `agent` con el resultado, tarjeta de
confirmación para `proposed_actions`, push tipo `agent`, y los adaptadores
`grokbot`, `hermes` y `a2a` (hoy responden `not_implemented`) más
`agent-task` (el agente baja la tarea completa con su token).
