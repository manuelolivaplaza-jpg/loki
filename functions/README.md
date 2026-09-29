# functions/ — backend de Loki IA (T18)

Cloud Functions (gen 2, Node 22) de la IA de Loki: la callable `aiChat`, el
trigger `onMention` de `@loki` / `@ai` en los chats de espacio y la rutina
programada `smartReminders`.

> ## ⛔ El despliegue está PROHIBIDO en las fases 1-2
>
> Este proyecto **compila, pero no se despliega**. Sigue sin ejecutar
> `firebase deploy` contra ningún proyecto real: el plan Blaze no está
> activo y la IA está apagada por diseño (`NEXT_PUBLIC_AI_ENABLED=false` en
> `.env.example`), así que la app responde con el streaming **simulado**.
>
> Está bloqueado a propósito en dos sitios:
>
> - `functions/package.json` → `npm run deploy` llama a
>   `scripts/no-deploy.cjs` y falla con un mensaje explicativo.
> - `firebase.json` (raíz) → `functions.predeploy` llama al mismo script, de
>   modo que un `firebase deploy` accidental se detiene antes de subir nada.
>
> La clave `predeploy` usa **`$RESOURCE_DIR`** (no una ruta fija):
>
> ```json
> "predeploy": ["node \"$RESOURCE_DIR/scripts/no-deploy.cjs\""]
> ```
>
> firebase-tools ejecuta los hooks desde la **raíz del proyecto** (no desde
> `functions/`), así que un `node scripts/no-deploy.cjs` a secas apuntaría a
> `<raíz>/scripts/` y moriría con `Cannot find module` en vez del mensaje
> claro. `$RESOURCE_DIR` es la variable que firebase-tools define con el
> valor de `functions.source`, y con comillas dobles (como hace el propio
> firebase-tools en `npm --prefix "$RESOURCE_DIR" run build`) porque en
> Windows el hook corre bajo `cmd.exe`, donde las comillas simples no
> agruparían una ruta con espacios. Verificado: con la ruta sin `$RESOURCE_DIR`
> salía `Cannot find module ...\loki\scripts\no-deploy.cjs`; con ella sale el
> "DEPLOY PROHIBIDO".
>
> Para desactivar el bloqueo (fase 3) hay que: pasar el proyecto al plan
> Blaze, borrar la clave `predeploy` de `firebase.json`, definir los secretos
> de abajo y compilar la app con `NEXT_PUBLIC_AI_ENABLED=true`.

## Compilar

```bash
cd functions
npm install
npm run build     # tsc → lib/  (lib/ y node_modules/ están en .gitignore)
npm run lint      # eslint con el .eslintrc.json de esta carpeta
```

`firebase.json` apunta a esta carpeta (`functions.source = "functions"`), así
que los emuladores de funciones, si alguna vez se activan, compilan desde aquí.
El proyecto de la app **no** depende de `firebase-functions` ni de
`firebase-admin`: sus dependencias viven solo en `functions/package.json`.

## Estructura

| Archivo | Contenido |
|---|---|
| `src/index.ts` | Exporta `aiChat` (callable) y re-exporta las otras dos. Configura la región global. |
| `src/ai.ts` | `AiProvider` (interfaz) + `GeminiProvider` + `ClaudeProvider`, los `defineSecret`, la selección por `AI_PROVIDER` y el prompt de sistema. |
| `src/admin.ts` | Init de `firebase-admin` y las dos escrituras con Admin SDK (`writeAiMessage`, `writeWorkspaceAiMessage`). |
| `src/onMention.ts` | `onDocumentCreated` en `workspaces/{wsId}/chats/{chatId}/messages/{messageId}`. |
| `src/smartReminders.ts` | `onSchedule` cada hora. **Stub**: por ahora solo log (ver el encabezado del archivo para el plan). |
| `scripts/no-deploy.cjs` | Cortafuegos de despliegue (fase 1-2). |

## Funciones

### `aiChat` (callable, `onCall`)

Chat privado del usuario: `users/{uid}/aiChats/{chatId}/messages`
(`chatId` por defecto `loki-ia`, el mismo id que la ruta `/chat/loki-ia`).

Entrada: `{ text, chatId?, history? }` · Salida: `{ messageId, chatId, text,
provider, model }`.

Hace, en este orden: valida la **sesión** (`request.auth`, si no →
`unauthenticated`), valida el texto (no vacío, ≤ 4000 caracteres), elige
proveedor según `AI_PROVIDER`, llama al modelo con el historial recortado a
los últimos 20 turnos y **escribe la respuesta con Admin SDK** como
`type: "ai"`. La app la ve al instante por `onSnapshot`
(`useAiMessages` → `listenAiMessages`), así que el cliente no necesita
permisos especiales.

> La app todavía **no** llama a esta callable (queda un `TODO(T18-siguiente)`
> en `src/components/chat/conversation-view.tsx`): con
> `NEXT_PUBLIC_AI_ENABLED=true` la UI se queda en "Conectando con Loki…" y no
> inventa nada, porque el backend aún no está desplegado.

### `onMention` (`onDocumentCreated`)

Se dispara con cada mensaje nuevo de un chat de espacio. Si `mentions[]`
incluye `loki`/`ai` o el texto trae `@loki` / `@ai`, genera la respuesta y la
escribe en ese mismo chat con `type: "ai"` (y refresca `lastMessage` del chat
para que salga en la lista). Ignora mensajes `type: "ai"` y borrados, para no
reaccionar a su propia respuesta.

### `smartReminders` (`onSchedule`, cada hora)

**Stub de la fase 1-2**: solo escribe un log. El encabezado del archivo
documenta el plan completo (leer calendarios, deduplicar un aviso por día y
usuario, y escribir en el chat privado un texto tipo *"Manu, recuerda que hoy
a las 7pm tienes cita con el médico."*).

## Los mensajes `type: "ai"` los escribe SOLO el Admin SDK

Las reglas (`firestore.rules`, raíz del repo) no dejan que el cliente cree
mensajes de IA en los chats de espacio:

```
allow create: if ... && request.resource.data.type in ['user', 'post', 'system']
```

Es decir, el `type: "ai"` está **prohibido** al cliente en
`workspaces/{wsId}/chats/{chatId}/messages`. Por eso `aiChat` y `onMention`
escriben con `firebase-admin` (privilegio de Admin, saltan las reglas a
propósito) y **nunca** con el SDK de cliente. Del lado de la app no hay
ningún camino que escriba `type: "ai"` en un chat de espacio: el único
`sendAiAssistantMessage` del cliente apunta a
`users/{uid}/aiChats/{chatId}/messages`, donde las reglas sí permiten
`type: "ai"` al propio usuario, y solo se usa para el texto MOCK
(`"[Simulado] …"`) del streaming simulado de la fase 1-2. Cuando haya
backend desplegado, ese mock desaparece y la respuesta llega escrita por
estas funciones.

## Secretos (nunca en el código)

No hay ninguna clave en el repositorio. Se declaran con `defineSecret` en
`src/ai.ts` y se leen con `.value()` solo dentro de la ejecución:

| Secreto / variable | Para qué |
|---|---|
| `GEMINI_API_KEY` | Secreto de Google Gemini (`GeminiProvider`). |
| `ANTHROPIC_API_KEY` | Secreto de Anthropic / Claude (`ClaudeProvider`). |
| `AI_PROVIDER` | `gemini` (por defecto) o `anthropic` / `claude`: elige implementación. |
| `GEMINI_MODEL` | Opcional; por defecto `gemini-2.0-flash`. |
| `CLAUDE_MODEL` | Opcional; por defecto `claude-3-5-haiku-latest`. |

Cuando llegue el momento del despliegue (fase 3):

```bash
firebase functions:secrets:set GEMINI_API_KEY
firebase functions:secrets:set ANTHROPIC_API_KEY
firebase functions:config   # o variables de entorno del servicio
```

`AI_PROVIDER` no es un secreto: es una variable de entorno del servicio
(`firebase functions:config:set` / `.env` de App Hosting). Si falta el
secreto del proveedor elegido, la función responde con un
`failed-precondition` y un log claro, nunca con una llamada a la API usando
una clave vacía.

## Turning it on (fase 3, no ahora)

1. Plan Blaze del proyecto.
2. Secretos + `AI_PROVIDER` configurados (arriba).
3. Quitar el bloqueo: borrar `predeploy` de `firebase.json` y el script
   `deploy` de `functions/package.json`.
4. `firebase deploy --only functions`.
5. Recompilar la app con `NEXT_PUBLIC_AI_ENABLED=true` y llamar a la
   callable `aiChat` desde `conversation-view.tsx` (el `TODO(T18-siguiente)`).

Mientras tanto, la app con `NEXT_PUBLIC_AI_ENABLED=false`:

- `/chat/loki-ia` escribe tu mensaje y una respuesta MOCK `[Simulado] …`
  revelada palabra a palabra (30 ms).
- Si escribes `@loki` / `@ai` en un chat de espacio, sale el aviso de sistema
  *"Loki está desactivada. Actívala en Configuración → Loki IA."*.
- `Configuración → Loki IA` muestra el estado real del flag.
