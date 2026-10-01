"use client";

import * as React from "react";
import { MessageCircle, Sparkles } from "lucide-react";
import { AiConnecting } from "@/components/chat/ai-connecting";
import { AiSuggestions } from "@/components/chat/ai-suggestions";
import { AiToolCard, UndoBar, type CardConfirmPayload } from "@/components/chat/ai-tool-card";
import { ConvertSheet, type ConvertKind } from "@/components/chat/convert-sheet";
import {
  DigestJobStatus,
  DigestPanel,
  DigestPill,
  type ChatDigest,
} from "@/components/chat/digest-panel";
import { Composer } from "@/components/chat/composer";
import { MessageBubble } from "@/components/chat/message-bubble";
import { MessageList } from "@/components/chat/message-list";
import { NewMessagesPill } from "@/components/chat/new-messages-pill";
import { ThreadPanel } from "@/components/chat/thread-panel";
import { TypingIndicator } from "@/components/chat/typing-indicator";
import { EmptyState } from "@/components/ui/empty-state";
import { QueryRetry } from "@/components/ui/query-retry";
import { useListWindow } from "@/lib/virtual-window";
import {
  useAiMessages,
  useChats,
  useMarkChatRead,
  useMembers,
  useMessages,
  useNotifyTyping,
  useSendAiMessage,
  useSendMessage,
  useTyping,
} from "@/hooks/use-chat";
import {
  deleteMessage,
  editMessage,
  fetchMyRead,
  fetchUnreadWindow,
  membersToCandidates,
  newMessageId,
  toggleReaction,
} from "@/lib/data/chat";
import {
  buildLokiDisabledMessage,
  LOKI_CANDIDATE,
  mentionsLoki,
} from "@/lib/chat/mentions";
import {
  AI_AUTHOR_ID,
  AI_CHAT_ID,
  AI_CHAT_NAME,
  AI_EMPTY_DESCRIPTION,
  AI_EMPTY_TITLE,
  AI_PLACEHOLDER,
} from "@/lib/ai/constants";
import {
  getLokiStatus,
  LOKI_NOT_CONFIGURED_TITLE,
  LokiError,
} from "@/lib/ai/loki";
import {
  confirmLokiAction,
  sendLokiWithTools,
  type AiPendingAction,
  type CreatedResult,
  type LokiConfirmInput,
  type UndoItem,
} from "@/lib/ai/tools-client";
import { useProjects } from "@/hooks/use-organizer";
import { getSupabaseClient } from "@/lib/supabase/client";
import {
  getAiJobResult,
  getCachedChatDigest,
  listenAiJob,
  requestAiJob,
} from "@/lib/data/ai-jobs";
import { useMessageStatusStore } from "@/lib/chat/message-status";
import { Timestamp } from "@/lib/timestamp";
import { useProfileStore } from "@/stores/profile-store";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaces } from "@/stores/workspace-store";
import type { MessageAttachment, MessageDoc, MessageReplyRef } from "@/types/chat";

const NEAR_BOTTOM_PX = 120;

function scrollToBottom(el: HTMLElement, smooth: boolean): void {
  const reduced =
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollTo({ top: el.scrollHeight, behavior: smooth && !reduced ? "smooth" : "auto" });
}

/**
 * Vista de conversación real: mensajes de Supabase + composer Grok.
 *
 * Con `chatId === "loki-ia"` los mensajes salen del chat PRIVADO del usuario
 * (`ai_messages`, T23): no hay paging hacia atrás, ni typing, ni reacciones,
 * y la respuesta de la IA va sin burbuja. El resto de la vista (scroll, pill,
 * composer, hilos) es el mismo de T13–T16.
 */
export function ConversationView({ chatId }: { chatId: string }): React.JSX.Element {
  // El chat de Loki no tiene typing de otras personas: la lista y los hilos
  // son de los chats de espacio (T14).
  const isLoki = chatId === AI_CHAT_ID;
  const { currentWorkspaceId, workspaces } = useWorkspaces();
  const user = useSessionStore((state) => state.user);
  const profile = useProfileStore((state) => state.profile);
  const chatsQuery = useChats(isLoki ? null : currentWorkspaceId);
  const chat = React.useMemo(
    () => (chatsQuery.data ?? []).find((item) => item.id === chatId) ?? null,
    [chatsQuery.data, chatId],
  );
  const chatName = isLoki ? AI_CHAT_NAME : (chat?.name ?? "Chat");

  const messagesState = useMessages(
    isLoki ? null : currentWorkspaceId,
    isLoki ? null : chatId,
  );
  const sendMutation = useSendMessage(
    isLoki ? null : currentWorkspaceId,
    isLoki ? null : chatId,
  );

  // Chat privado con Loki: mensajes de `ai_messages` + respuesta real de la
  // Edge Function `loki-chat` (streaming SSE con cursor en vivo). Sin
  // proveedor configurado se avisa y el composer se deshabilita (no hay
  // mock ni "[Simulado]").
  const currentUid = user?.uid ?? null;
  const aiQuery = useAiMessages(isLoki ? currentUid : null, isLoki ? chatId : null);
  const sendAiUser = useSendAiMessage(isLoki ? currentUid : null, isLoki ? chatId : null);
  const [aiConnecting, setAiConnecting] = React.useState(false);
  const [lokiConfigured, setLokiConfigured] = React.useState<boolean | null>(null);
  const [streamingText, setStreamingText] = React.useState<string | null>(null);
  const lokiStatusRef = React.useRef<Promise<boolean> | null>(null);
  // Acción de escritura pendiente de confirmación (protocolo tool_pending de
  // la Edge): la tarjeta se muestra tanto en el chat privado como en los de
  // espacio (el contexto para el segundo POST vive en `toolCtxRef`).
  const [toolPending, setToolPending] = React.useState<AiPendingAction | null>(null);
  const [toolSending, setToolSending] = React.useState(false);
  // Resultado con enlaces + deshacer tras confirmar (protocolo `created`).
  const [created, setCreated] = React.useState<CreatedResult | null>(null);
  // Conversión mensaje -> tarea/evento/recordatorio.
  const [converting, setConverting] = React.useState<{
    message: MessageDoc;
    kind: ConvertKind;
  } | null>(null);
  // Resumen de no leídos (pastilla + trabajo + tarjeta privada).
  const [digestWindow, setDigestWindow] = React.useState<{
    count: number;
    lastId: string | null;
    since: string | null;
  } | null>(null);
  const [digestJobId, setDigestJobId] = React.useState<string | null>(null);
  const [digestJobError, setDigestJobError] = React.useState<string | null>(null);
  const [digest, setDigest] = React.useState<{
    data: ChatDigest;
    cached: boolean;
  } | null>(null);
  const [digestBusy, setDigestBusy] = React.useState(false);
  type ToolCtx =
    | { mode: "personal" }
    | { mode: "mention"; workspaceId: string; chatId: string; threadParentId?: string };
  const toolCtxRef = React.useRef<ToolCtx | null>(null);

  // Estado del proveedor (una vez por vista; ante un corte, sin configurar).
  const ensureLokiConfigured = React.useCallback(async (): Promise<boolean> => {
    if (lokiStatusRef.current === null) {
      lokiStatusRef.current = getLokiStatus().then(
        (status) => {
          setLokiConfigured(status.configured);
          return status.configured;
        },
        () => {
          setLokiConfigured(false);
          return false;
        },
      );
    }
    return lokiStatusRef.current;
  }, []);

  React.useEffect(() => {
    void ensureLokiConfigured();
  }, [ensureLokiConfigured]);

  // Burbuja provisional con el stream en vivo (la fila persistida llega por
  // realtime al terminar y este texto se retira).
  const streamingMessage = React.useMemo<MessageDoc | null>(() => {
    if (!isLoki || streamingText === null) return null;
    return {
      id: "loki-streaming",
      authorId: AI_AUTHOR_ID,
      authorName: AI_CHAT_NAME,
      text: streamingText,
      mentions: [],
      replyTo: null,
      threadParentId: null,
      threadCount: 0,
      lastReplyAt: null,
      attachments: [],
      reactions: {},
      lastReaction: null,
      createdAt: Timestamp.now(),
      editedAt: null,
      deleted: false,
      type: "ai",
    };
  }, [isLoki, streamingText]);

  const messages = React.useMemo(
    () => (isLoki ? (aiQuery.data ?? []) : messagesState.messages),
    [isLoki, aiQuery.data, messagesState.messages],
  );
  const hasMore = isLoki ? false : messagesState.hasMore;
  const isLoadingOlder = isLoki ? false : messagesState.isLoadingOlder;
  const loadOlder = React.useCallback(async (): Promise<void> => {
    if (isLoki) return;
    await messagesState.loadOlder();
  }, [isLoki, messagesState]);

  // T35: ventana virtual ligera (windowing por intersección, sin
  // librerías): solo se pintan los últimos `limit` mensajes. El centinela
  // superior pide la página anterior (cursor) y agranda la ventana.
  const listWindow = useListWindow({
    total: messages.length,
    hasMore,
    onLoadOlder: isLoki ? undefined : loadOlder,
    resetKey: isLoki ? "loki" : chatId,
  });
  const visibleMessages = React.useMemo(
    () =>
      isLoki || messages.length <= listWindow.limit
        ? messages
        : messages.slice(messages.length - listWindow.limit),
    [isLoki, messages, listWindow.limit],
  );

  const profileName = profile?.displayName?.trim() ?? "";
  const sessionName = user?.displayName?.trim() ?? "";
  const authorName = profileName !== "" ? profileName : sessionName !== "" ? sessionName : "Miembro";

  // T14: typing en vivo (sin mí), aviso de escritura y marcas de lectura.
  const wsForLive = isLoki ? null : currentWorkspaceId;
  const chatForLive = isLoki ? null : chatId;
  const typingNames = useTyping(wsForLive, chatForLive, currentUid);
  // T15: miembros del espacio para el menú @ del composer.
  const membersQuery = useMembers(wsForLive);
  const mentionMembers = React.useMemo(
    () => membersToCandidates(membersQuery.data ?? []),
    [membersQuery.data],
  );
  // En el chat privado con Loki no hay menú de menciones (se habla con la IA
  // sin escribir @nombre). `wsForLive` es null ahí, así que `useMembers` no
  // consulta nada y esta lista ya sale vacía.
  const { notify: notifyTyping } = useNotifyTyping(
    wsForLive,
    chatForLive,
    currentUid,
    authorName,
  );
  const markAsRead = useMarkChatRead(wsForLive, chatForLive, currentUid);
  const sendStatus = useMessageStatusStore((state) => state.status);

  const scrollRef = React.useRef<HTMLDivElement>(null);
  const nearBottomRef = React.useRef(true);
  const primedRef = React.useRef(false);
  const [animatedIds, setAnimatedIds] = React.useState<Set<string>>(new Set());
  const [showNewPill, setShowNewPill] = React.useState(false);
  const [sendError, setSendError] = React.useState<string | null>(null);
  // T16: cita en el composer, edición en curso, hilo abierto y avisos
  // efímeros (copiado) que no son errores.
  const [replyTo, setReplyTo] = React.useState<MessageReplyRef | null>(null);
  const [editing, setEditing] = React.useState<{ id: string; text: string } | null>(null);
  const [threadParent, setThreadParent] = React.useState<MessageDoc | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const noticeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const showNotice = React.useCallback((text: string) => {
    if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    setNotice(text);
    noticeTimerRef.current = setTimeout(() => {
      noticeTimerRef.current = null;
      setNotice(null);
    }, 1800);
  }, []);

  React.useEffect(
    () => () => {
      if (noticeTimerRef.current !== null) clearTimeout(noticeTimerRef.current);
    },
    [],
  );

  // Id del último mensaje: al abrir y al llegar al fondo se marca leído.
  const latestId =
    messages.length > 0 ? (messages[messages.length - 1]?.id ?? null) : null;
  const latestIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    latestIdRef.current = latestId;
    if (!isLoki && latestId !== null && nearBottomRef.current) {
      markAsRead(latestId);
    }
  }, [isLoki, latestId, markAsRead]);

  // Apertura: scroll al final sin animación.
  React.useEffect(() => {
    primedRef.current = false;
    setAnimatedIds(new Set());
    setShowNewPill(false);
    // T16: al cambiar de chat no queda cita, edición ni hilo abiertos.
    setReplyTo(null);
    setEditing(null);
    setThreadParent(null);
    // Ni acciones de Loki pendientes de confirmar.
    setToolPending(null);
    setCreated(null);
    setConverting(null);
    setDigestWindow(null);
    setDigestJobId(null);
    setDigestJobError(null);
    setDigest(null);
    toolCtxRef.current = null;
  }, [chatId]);

  // Marca como animables los ids que llegan tras el primer pintado.
  const initialIdsRef = React.useRef<Set<string> | null>(null);
  React.useEffect(() => {
    if (messages.length === 0) return;
    if (initialIdsRef.current === null) {
      initialIdsRef.current = new Set(messages.map((m) => m.id));
      const el = scrollRef.current;
      if (el !== null && !primedRef.current) {
        primedRef.current = true;
        el.scrollTop = el.scrollHeight;
      }
      return;
    }
    const known = initialIdsRef.current;
    const fresh = messages.map((m) => m.id).filter((id) => !known.has(id));
    if (fresh.length === 0) return;
    for (const id of fresh) known.add(id);
    setAnimatedIds((prev) => new Set([...prev, ...fresh]));
    const el = scrollRef.current;
    if (el === null) return;
    const last = messages[messages.length - 1];
    const mine = last !== undefined && currentUid !== null && last.authorId === currentUid;
    if (mine) {
      scrollToBottom(el, false);
      setShowNewPill(false);
      return;
    }
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    if (distance < NEAR_BOTTOM_PX) {
      scrollToBottom(el, false);
    } else {
      setShowNewPill(true);
    }
  }, [messages, currentUid]);

  React.useEffect(() => {
    initialIdsRef.current = null;
  }, [chatId]);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    nearBottomRef.current = distance < NEAR_BOTTOM_PX;
    if (nearBottomRef.current) {
      setShowNewPill(false);
      // Al llegar al fondo se actualiza la marca de lectura.
      const latestId = latestIdRef.current;
      if (!isLoki && latestId !== null) markAsRead(latestId);
    }
  }, [isLoki, markAsRead]);

  // Paginación hacia atrás + ventana virtual (T35): el centinela de
  // `useListWindow` pide la página anterior y agranda la ventana
  // conservando la posición de scroll. El scroll comparte su nodo con la
  // ventana para que el observer mida el contenedor real.
  const setScrollRefs = React.useCallback(
    (el: HTMLDivElement | null) => {
      scrollRef.current = el;
      listWindow.scrollerRef.current = el;
    },
    [listWindow],
  );

  /** Confirma o cancela la acción pendiente (segundo POST con `confirm`). */
  const handleToolConfirm = React.useCallback(
    (ok: boolean, payload?: CardConfirmPayload) => {
      const pending = toolPending;
      const ctx = toolCtxRef.current;
      if (pending === null || ctx === null) return;
      setToolPending(null);
      setToolSending(true);
      setCreated(null);
      if (isLoki) setStreamingText("");
      // Espacio cambiado en la tarjeta (modo personal): se inyecta en los
      // parámetros de la acción única y de cada acción incluida del plan.
      const overrideWs = payload?.workspaceId;
      const withWs = (
        params: Record<string, unknown>,
      ): Record<string, unknown> =>
        overrideWs === undefined || overrideWs === ""
          ? params
          : { ...params, workspaceId: overrideWs };
      const confirm = {
        id: pending.id,
        action: pending.action,
        params: withWs(payload?.params ?? pending.params),
        ok,
        ...(payload?.actions !== undefined
          ? {
            actions: payload.actions.map((item) => ({
              action: item.action,
              params: withWs(item.params),
              include: item.include,
            })),
          }
          : {}),
      };
      const input: LokiConfirmInput =
        ctx.mode === "mention"
          ? {
            mode: "mention",
            text: "",
            workspaceId: ctx.workspaceId,
            chatId: ctx.chatId,
            ...(ctx.threadParentId !== undefined
              ? { threadParentId: ctx.threadParentId }
              : {}),
            confirm,
          }
          : { mode: "personal", text: "", confirm };
      void confirmLokiAction(input, (full) => {
        if (isLoki) setStreamingText(full);
      }).then(
        () => undefined,
        (error: unknown) => {
          setSendError(
            error instanceof Error ? error.message : "Loki no pudo responder.",
          );
        },
      ).finally(() => {
        setToolSending(false);
        if (isLoki) setStreamingText(null);
      });
    },
    [toolPending, isLoki],
  );

  /** Deshace lo recién creado por Loki (tarea, evento o aviso). */
  const handleUndo = React.useCallback(
    async (items: UndoItem[]) => {
      const client = getSupabaseClient();
      for (const item of items) {
        if (item.kind === "task") {
          const { error } = await client.from("tasks").delete().eq("id", item.id);
          if (error !== null) {
            setSendError("No se pudo deshacer todo. Revisa la pantalla correspondiente.");
            return;
          }
        } else if (item.kind === "event") {
          const { error } = await client.from("events").delete().eq("id", item.id);
          if (error !== null) {
            setSendError("No se pudo deshacer todo. Revisa la pantalla correspondiente.");
            return;
          }
        } else {
          const { error } = await client
            .from("messages")
            .update({ deleted: true })
            .eq("id", item.id);
          if (error !== null) {
            setSendError("No se pudo deshacer todo. Revisa la pantalla correspondiente.");
            return;
          }
        }
      }
    },
    [],
  );

  /** Datos para los selectores de la tarjeta (responsables y proyectos). */
  const toolWsId = React.useMemo(() => {
    if (toolCtxRef.current?.mode === "mention") return toolCtxRef.current.workspaceId;
    const fromParams = toolPending?.params["workspaceId"];
    if (typeof fromParams === "string" && fromParams !== "") return fromParams;
    return currentWorkspaceId;
  }, [toolPending, currentWorkspaceId]);
  const toolProjectsQuery = useProjects(toolPending === null ? null : toolWsId);

  // Ventana de no leídos (solo chats de espacio): para la pastilla de resumen.
  React.useEffect(() => {
    if (isLoki || wsForLive === null || currentUid === null) {
      setDigestWindow(null);
      return;
    }
    let cancelled = false;
    const wsId = wsForLive;
    const uid = currentUid;
    void (async () => {
      const read = await fetchMyRead(wsId, chatId, uid).catch(() => null);
      const lastRead = read?.lastReadAt ?? null;
      const sinceMs = lastRead === null ? null : lastRead.toDate().getTime();
      const window = await fetchUnreadWindow(wsId, chatId, uid, sinceMs).catch(() => null);
      if (!cancelled && window !== null) setDigestWindow(window);
    })();
    return () => {
      cancelled = true;
    };
  }, [isLoki, wsForLive, currentUid, chatId, messages.length]);

  function digestToPanel(result: Record<string, unknown>): ChatDigest {
    const strList = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((v): v is string => typeof v === "string").slice(0, 8)
        : [];
    const pointsRaw = Array.isArray(result["points"]) ? result["points"] : [];
    const points = pointsRaw.slice(0, 8).map((p) => {
      if (typeof p === "string") return { text: p.slice(0, 300), msg: "" };
      if (typeof p === "object" && p !== null) {
        const rec = p as Record<string, unknown>;
        return {
          text: typeof rec["text"] === "string" ? rec["text"].slice(0, 300) : "",
          msg: typeof rec["msg"] === "string" ? rec["msg"] : "",
        };
      }
      return { text: "", msg: "" };
    }).filter((p) => p.text !== "");
    return {
      points,
      decisions: strList(result["decisions"]),
      questions: strList(result["questions"]),
      mentions: strList(result["mentions"]),
    };
  }

  /** Pide el resumen: caché vigente primero, si no encola el trabajo. */
  const handleDigest = React.useCallback(async () => {
    if (
      isLoki || wsForLive === null || currentUid === null || digestWindow === null ||
      digestWindow.lastId === null || digestBusy
    ) {
      return;
    }
    setDigestBusy(true);
    setDigestJobError(null);
    try {
      const cached = await getCachedChatDigest(currentUid, wsForLive, chatId);
      if (cached !== null && cached.lastMessageId === digestWindow.lastId) {
        setDigest({ data: digestToPanel(cached.digest), cached: true });
        return;
      }
      const jobId = await requestAiJob(wsForLive, currentUid, "chat_digest", {
        chat_id: chatId,
        after: digestWindow.since,
        upto: digestWindow.lastId,
      }, `digest:${wsForLive}:${chatId}:${digestWindow.lastId}`);
      setDigestJobId(jobId);
    } catch (error) {
      setDigestJobError(error instanceof Error ? error.message : "No se pudo pedir el resumen.");
    } finally {
      setDigestBusy(false);
    }
  }, [isLoki, wsForLive, currentUid, digestWindow, digestBusy, chatId]);

  // Resultado del trabajo en vivo: al terminar se lee el resultado.
  React.useEffect(() => {
    if (digestJobId === null) return;
    const stop = listenAiJob(digestJobId, (job) => {
      if (job === null || job.status === "queued" || job.status === "running") return;
      stop();
      setDigestJobId(null);
      if (job.status !== "done") {
        setDigestJobError(job.error ?? "El resumen falló. Reinténtalo.");
        return;
      }
      void getAiJobResult(digestJobId).then((result) => {
        if (result !== null) setDigest({ data: digestToPanel(result), cached: false });
      });
    });
    return stop;
  }, [digestJobId]);

  /** Un punto del resumen se convierte en tarea (mismo flujo manual). */
  const handleDigestPoint = React.useCallback(
    (title: string) => {
      const pseudo: MessageDoc = {
        id: `digest-point-${Date.now()}`,
        authorId: currentUid ?? "",
        authorName: chatName,
        text: title,
        mentions: [],
        replyTo: null,
        threadParentId: null,
        threadCount: 0,
        lastReplyAt: null,
        attachments: [],
        reactions: {},
        lastReaction: null,
        createdAt: Timestamp.now(),
        editedAt: null,
        deleted: false,
        type: "user",
      };
      setConverting({ message: pseudo, kind: "task" });
    },
    [currentUid, chatName],
  );

  const handleSend = React.useCallback(
    (text: string, mentions: string[], attachments?: MessageAttachment[]) => {
      setSendError(null);
      // T16: la cita vive solo en el envío siguiente.
      const quote = replyTo;
      setReplyTo(null);
      if (isLoki) {
        // Mi mensaje va al chat privado y la respuesta la genera la Edge
        // Function (streaming real con cursor en vivo; la fila persistida
        // llega por realtime). Sin proveedor, aviso y composer deshabilitado.
        if (currentUid === null) {
          setSendError("Inicia sesión para hablar con Loki.");
          return;
        }
        const prompt = text;
        sendAiUser.mutate(
          { authorName, text: prompt },
          {
            onSuccess: () => {
              requestAnimationFrame(() => {
                const el = scrollRef.current;
                if (el !== null) scrollToBottom(el, false);
              });
              void (async () => {
                // Sin proveedor solo sale la vía determinista (la Edge la
                // ofrece igual); el resto responde 503 y se avisa.
                setAiConnecting(true);
                setStreamingText("");
                try {
                  await sendLokiWithTools(
                    { mode: "personal", text: prompt },
                    {
                      onChunk: (full) => {
                        setStreamingText(full);
                      },
                      onToolPending: (action) => {
                        toolCtxRef.current = { mode: "personal" };
                        setToolPending(action);
                      },
                      onCreated: (result) => {
                        setCreated(result);
                      },
                    },
                  );
                } catch (error: unknown) {
                  if (error instanceof LokiError && error.code === "not_configured") {
                    setSendError(LOKI_NOT_CONFIGURED_TITLE);
                  } else {
                    setSendError(
                      error instanceof Error ? error.message : "Loki no pudo responder.",
                    );
                  }
                } finally {
                  setAiConnecting(false);
                  setStreamingText(null);
                }
              })();
            },
            onError: (error) => setSendError(error.message),
          },
        );
        return;
      }
      if (currentUid === null) {
        setSendError("Inicia sesión para enviar mensajes.");
        return;
      }
      if (wsForLive === null || chatForLive === null) {
        setSendError("Falta el espacio o el chat.");
        return;
      }
      // Id de cliente para el envío optimista (el reintento reusa el mismo).
      const messageId = newMessageId(wsForLive, chatForLive);
      sendMutation.mutate(
        {
          authorId: currentUid,
          authorName,
          text,
          mentions,
          replyTo: quote,
          attachments,
          type: "user",
          messageId,
        },
        {
          onSuccess: () => {
            requestAnimationFrame(() => {
              const el = scrollRef.current;
              if (el !== null) scrollToBottom(el, false);
            });
            // Si nombra a Loki, la respuesta real la escribe la Edge Function
            // (modo mention) con la service role y llega por realtime. Sin
            // proveedor, aviso de sistema sutil del propio usuario (type
            // "system": lo único escribible por el cliente, ya que la RLS
            // prohíbe type "ai" ahí). El aviso NO toca el preview del chat
            // (el trigger solo mira user/post/ai sin hilo), así que la lista
            // sigue enseñando el último mensaje real.
            if (mentionsLoki(text, mentions)) {
              const mentionWsId = wsForLive;
              const mentionChatId = chatForLive;
              void (async () => {
                try {
                  // El hilo abierto es el contexto de @loki: la respuesta se
                  // guarda en ese hilo (threadParentId).
                  const threadId = threadParent?.id;
                  await sendLokiWithTools(
                    {
                      mode: "mention",
                      text,
                      workspaceId: mentionWsId,
                      chatId: mentionChatId,
                      ...(threadId !== undefined ? { threadParentId: threadId } : {}),
                    },
                    {
                      onChunk: () => undefined,
                      onToolPending: (action) => {
                        toolCtxRef.current = {
                          mode: "mention",
                          workspaceId: mentionWsId,
                          chatId: mentionChatId,
                          ...(threadId !== undefined ? { threadParentId: threadId } : {}),
                        };
                        setToolPending(action);
                      },
                      onCreated: (result) => {
                        setCreated(result);
                      },
                    },
                  );
                } catch (error: unknown) {
                  // Sin proveedor, aviso de sistema sutil (type "system": lo
                  // único escribible por el cliente). La vía determinista no
                  // necesita proveedor y llega como tarjeta igual.
                  if (error instanceof LokiError && error.code === "not_configured") {
                    const aviso = buildLokiDisabledMessage(currentUid, authorName);
                    sendMutation.mutate(
                      {
                        authorId: aviso.authorId,
                        authorName: aviso.authorName,
                        text: aviso.text,
                        mentions: aviso.mentions,
                        type: aviso.type,
                      },
                      {
                        onError: (error) => setSendError(error.message),
                      },
                    );
                    return;
                  }
                  setSendError(
                    error instanceof Error ? error.message : "Loki no pudo responder.",
                  );
                }
              })();
            }
          },
          onError: (error) => setSendError(error.message),
        },
      );
    },
    [isLoki, currentUid, authorName, sendAiUser, sendMutation, wsForLive, chatForLive, replyTo, ensureLokiConfigured, threadParent],
  );

  // --- T16: reacciones, citas, edición, borrado e hilos ----------------------

  /** Contexto real de escritura; null en el chat de Loki o sin sesión. */
  const liveContext = React.useMemo(
    () =>
      isLoki ||
      currentUid === null ||
      wsForLive === null ||
      chatForLive === null
        ? null
        : { wsId: wsForLive, chatId: chatForLive, uid: currentUid },
    [isLoki, currentUid, wsForLive, chatForLive],
  );

  /** Agrega o quita SOLO mi uid en ese emoji (lo que permiten las reglas). */
  const handleToggleReaction = React.useCallback(
    (message: MessageDoc, emoji: string, hasReacted: boolean) => {
      const ctx = liveContext;
      if (ctx === null) return;
      setSendError(null);
      void toggleReaction(
        ctx.wsId,
        ctx.chatId,
        message.id,
        emoji,
        ctx.uid,
        hasReacted,
      ).catch((error: unknown) => {
        setSendError(
          error instanceof Error ? error.message : "No se pudo reaccionar.",
        );
      });
    },
    [liveContext],
  );

  const handleReply = React.useCallback((message: MessageDoc) => {
    setEditing(null);
    setReplyTo({
      id: message.id,
      authorName: message.authorName,
      text: message.deleted ? "Mensaje eliminado" : message.text,
    });
  }, []);

  const handleCancelReply = React.useCallback(() => setReplyTo(null), []);

  const handleCopy = React.useCallback(
    (message: MessageDoc) => {
      const text = message.text;
      if (typeof navigator === "undefined" || navigator.clipboard === undefined) {
        setSendError("Este navegador no permite copiar.");
        return;
      }
      void navigator.clipboard.writeText(text).then(
        () => showNotice("Mensaje copiado"),
        () => setSendError("No se pudo copiar."),
      );
    },
    [showNotice],
  );

  const handleEdit = React.useCallback((message: MessageDoc) => {
    setReplyTo(null);
    setEditing({ id: message.id, text: message.text });
  }, []);

  const handleCancelEdit = React.useCallback(() => setEditing(null), []);

  /** Enter en modo edición: `editMessage` con el texto y sus menciones. */
  const handleSaveEdit = React.useCallback(
    (text: string, mentions: string[]) => {
      const ctx = liveContext;
      if (ctx === null || editing === null) return;
      setSendError(null);
      void editMessage(ctx.wsId, ctx.chatId, editing.id, text, mentions).then(
        () => {
          setEditing(null);
        },
        (error: unknown) => {
          setSendError(
            error instanceof Error ? error.message : "No se pudo editar.",
          );
        },
      );
    },
    [liveContext, editing],
  );

  /** Borrado suave: el doc queda `deleted` y la burbuja muestra el aviso. */
  const handleDelete = React.useCallback(
    (message: MessageDoc) => {
      const ctx = liveContext;
      if (ctx === null) return;
      setSendError(null);
      void deleteMessage(ctx.wsId, ctx.chatId, message.id).catch(
        (error: unknown) => {
          setSendError(
            error instanceof Error ? error.message : "No se pudo eliminar.",
          );
        },
      );
    },
    [liveContext],
  );

  const handleOpenThread = React.useCallback((message: MessageDoc) => {
    setThreadParent(message);
  }, []);

  const handleCloseThread = React.useCallback(() => setThreadParent(null), []);

  // El padre se resuelve contra la lista viva: si le llegan reacciones o
  // respuestas mientras el hilo está abierto, el panel no queda viejo.
  const threadParentLive = React.useMemo(() => {
    if (threadParent === null) return null;
    return messages.find((item) => item.id === threadParent.id) ?? threadParent;
  }, [threadParent, messages]);

  // Reintenta un mensaje fallido con el mismo id de cliente.
  const handleRetry = React.useCallback(
    (message: MessageDoc) => {
      setSendError(null);
      if (isLoki || currentUid === null) return;
      const retryType =
        message.type === "post" || message.type === "system" ? message.type : "user";
      sendMutation.mutate(
        {
          authorId: message.authorId,
          authorName: message.authorName,
          text: message.text,
          mentions: message.mentions,
          replyTo: message.replyTo,
          threadParentId: message.threadParentId,
          attachments: message.attachments,
          type: retryType,
          messageId: message.id,
        },
        {
          onError: (error) => setSendError(error.message),
        },
      );
    },
    [isLoki, currentUid, sendMutation],
  );

  const handlePillClick = React.useCallback(() => {
    const el = scrollRef.current;
    if (el === null) return;
    scrollToBottom(el, true);
    setShowNewPill(false);
  }, []);

  // Sin uid no hay chat privado que escuchar: `useAiMessages` queda
  // deshabilitado y su query "pendiente" para siempre, así que el esqueleto
  // solo se muestra cuando sí hay sesión (el resto de la vista ya avisa al
  // enviar con "Inicia sesión para hablar con Loki.").
  const isPending = isLoki
    ? currentUid !== null && aiQuery.isPending
    : messagesState.isPending;
  const loadError = isLoki ? aiQuery.error : messagesState.error;

  /** Un chip de sugerencia se envía como mensaje del usuario. */
  const handleSuggestion = React.useCallback(
    (text: string) => {
      handleSend(text, []);
    },
    [handleSend],
  );

  // Los chips siempre se muestran: los de acción van por la vía
  // determinista aunque no haya proveedor.
  const showSuggestions = true;

  return (
    <div className="flex h-[calc(100dvh-68px)] flex-col md:h-dvh">
      <span className="sr-only">Conversación con {chatName}</span>
      <div ref={setScrollRefs} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
        {isPending ? (
          <ul aria-label="Cargando mensajes" className="flex flex-col gap-2 px-4 py-4">
            {[0, 1, 2].map((index) => (
              <li
                key={index}
                aria-hidden="true"
                className={index % 2 === 0 ? "flex justify-start" : "flex justify-end"}
              >
                <span className="h-10 w-2/3 animate-pulse rounded-[22px] bg-surface-soft" />
              </li>
            ))}
          </ul>
        ) : loadError ? (
          <QueryRetry
            message="No se pudieron cargar los mensajes."
            onRetry={() => messagesState.retry()}
          />
        ) : messages.length === 0 ? (
          isLoki ? (
            <div className="mx-auto w-full max-w-[760px] px-4">
              <EmptyState
                icon={Sparkles}
                title={AI_EMPTY_TITLE}
                description={AI_EMPTY_DESCRIPTION}
                // Menos padding abajo: los chips van justo debajo y no hace
                // falta el aire de 64px del estado vacío normal.
                className="pb-6"
              />
              {showSuggestions ? <AiSuggestions onPick={handleSuggestion} /> : null}
            </div>
          ) : (
            <EmptyState
              icon={MessageCircle}
              title={`Bienvenido a ${chatName}`}
              description="Sé la primera persona en escribir en este chat."
            />
          )
        ) : (
          <div className="mx-auto w-full max-w-[760px]">
            <MessageList
              messages={visibleMessages}
              currentUid={currentUid}
              animatedIds={animatedIds}
              disableOwnReactions={isLoki}
              topSentinelRef={listWindow.topSentinelRef}
              isLoadingOlder={isLoadingOlder || listWindow.loadingOlder}
              hasMore={hasMore}
              sendStatus={sendStatus}
              onRetryMessage={handleRetry}
              onToggleReaction={handleToggleReaction}
              onReply={handleReply}
              onOpenThread={handleOpenThread}
              onCopy={handleCopy}
              onEdit={handleEdit}
              onDelete={handleDelete}
              onConvert={
                isLoki || wsForLive === null
                  ? undefined
                  : (message, kind) => setConverting({ message, kind })
              }
            />
            {streamingMessage !== null ? (
              <div className="px-4 pb-2">
                <MessageBubble
                  message={streamingMessage}
                  isMine={false}
                  showAuthor
                  showTime={false}
                  streaming
                />
              </div>
            ) : null}
          </div>
        )}
      </div>

      {!isLoki ? <TypingIndicator names={typingNames} /> : null}
      {isLoki && aiConnecting ? <AiConnecting /> : null}
      <div className="relative bg-gradient-to-t from-background via-background/85 to-transparent">
        <div className="absolute -top-12 left-0 right-0 flex flex-col items-center gap-2">
          <NewMessagesPill visible={showNewPill} onClick={handlePillClick} />
          {!isLoki && digestWindow !== null && digestWindow.count >= 15 && digest === null && digestJobId === null ? (
            <DigestPill
              count={digestWindow.count}
              disabled={lokiConfigured === false || digestBusy}
              disabledReason={
                lokiConfigured === false ? "Loki IA sin configurar" : undefined
              }
              onClick={() => void handleDigest()}
            />
          ) : null}
          {digestJobError !== null ? (
            <p role="alert" className="text-center text-body-sm text-danger">
              {digestJobError}
            </p>
          ) : null}
        </div>
        {sendError !== null ? (
          <p role="alert" className="px-4 pb-1 text-center text-body-sm text-danger">
            {sendError}
          </p>
        ) : null}
        {notice !== null ? (
          <p
            role="status"
            className="px-4 pb-1 text-center text-body-sm text-muted-foreground"
          >
            {notice}
          </p>
        ) : null}
        {toolPending !== null ? (
          <div className="mx-auto w-full max-w-[760px] px-4 pb-2">
            <AiToolCard
              pending={toolPending}
              sending={toolSending}
              members={(membersQuery.data ?? []).map((member) => ({
                uid: member.uid,
                name: member.displayName,
              }))}
              projects={(toolProjectsQuery.data ?? [])
                .filter((project) => project.status === "active")
                .map((project) => ({
                  id: project.id,
                  name: project.name,
                  isSystem: project.isSystem,
                }))}
              workspaces={isLoki ? workspaces.map((ws) => ({ id: ws.wsId, name: ws.name })) : undefined}
              initialWorkspaceId={
                typeof toolPending.params["workspaceId"] === "string"
                  ? (toolPending.params["workspaceId"] as string)
                  : undefined
              }
              onConfirm={(payload) => handleToolConfirm(true, payload)}
              onCancel={() => handleToolConfirm(false)}
            />
          </div>
        ) : null}
        {created !== null && created.undo.length > 0 ? (
          <div className="mx-auto w-full max-w-[760px] px-4 pb-2">
            <UndoBar
              items={created.undo}
              onUndo={(items) => void handleUndo(items)}
              onDone={() => setCreated(null)}
            />
          </div>
        ) : null}
        {digestJobId !== null ? (
          <div className="mx-auto w-full max-w-[760px] px-4 pb-2">
            <DigestJobStatus jobId={digestJobId} />
          </div>
        ) : null}
        {digest !== null ? (
          <div className="mx-auto w-full max-w-[760px] px-4 pb-2">
            <DigestPanel
              digest={digest.data}
              cached={digest.cached}
              refreshing={digestBusy}
              onConvertPoint={handleDigestPoint}
              onRefresh={() => {
                setDigest(null);
                void handleDigest();
              }}
            />
          </div>
        ) : null}
        {converting !== null && wsForLive !== null && currentUid !== null ? (
          <div className="mx-auto w-full max-w-[760px] px-0 pb-2">
            <ConvertSheet
              message={converting.message}
              wsId={wsForLive}
              chatId={chatId}
              uid={currentUid}
              authorName={authorName}
              kind={converting.kind}
              members={(membersQuery.data ?? []).map((member) => ({
                uid: member.uid,
                name: member.displayName,
              }))}
              onClose={() => setConverting(null)}
            />
          </div>
        ) : null}
        <Composer
          chatName={chatName}
          isLoki={isLoki}
          sending={isLoki ? sendAiUser.isPending || aiConnecting : sendMutation.isPending}
          // El composer siempre habilitado: sin proveedor la vía
          // determinista igual ofrece su tarjeta; el resto avisa.
          disabled={false}
          placeholder={isLoki ? AI_PLACEHOLDER : undefined}
          members={mentionMembers}
          onSend={handleSend}
          wsId={wsForLive}
          mediaBucket="chat-media"
          onValueChange={notifyTyping}
          edit={editing}
          onSaveEdit={handleSaveEdit}
          onCancelEdit={handleCancelEdit}
          replyTo={replyTo}
          onCancelReply={handleCancelReply}
        />
      </div>

      {threadParentLive !== null && wsForLive !== null && chatForLive !== null ? (
        <ThreadPanel
          wsId={wsForLive}
          chatId={chatForLive}
          parent={threadParentLive}
          currentUid={currentUid}
          authorName={authorName}
          members={[LOKI_CANDIDATE, ...mentionMembers]}
          onClose={handleCloseThread}
        />
      ) : null}
    </div>
  );
}
