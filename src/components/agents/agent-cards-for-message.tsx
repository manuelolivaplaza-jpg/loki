"use client";

import * as React from "react";
import { AgentRunCard } from "@/components/agents/agent-run-card";
import { useMessageAgentRuns, useSpaceAgents } from "@/hooks/use-agents";

/**
 * Tarjetas de ejecución bajo un mensaje que invocó agentes (@handle).
 * Una mención dispara una ejecución por agente; cada tarjeta muestra el
 * progreso en vivo (Realtime) y el resultado con sus acciones para confirmar.
 */
export function AgentCardsForMessage({
  wsId,
  messageId,
  uid,
  onOpenThread,
}: {
  wsId: string;
  messageId: string;
  uid: string | null;
  onOpenThread?: () => void;
}): React.JSX.Element | null {
  const { runs } = useMessageAgentRuns(messageId);
  const spaceAgents = useSpaceAgents(wsId);
  const meta = React.useMemo(() => {
    const byId = new Map(
      (spaceAgents.data ?? []).map((entry) => [entry.connection.id, entry] as const),
    );
    return byId;
  }, [spaceAgents.data]);

  if (runs.length === 0) return null;
  return (
    <div className="flex w-full flex-col items-start gap-2 pt-1.5">
      {runs.map((run) => {
        const entry = meta.get(run.connectionId);
        return (
          <AgentRunCard
            key={run.id}
            runId={run.id}
            wsId={wsId}
            uid={uid}
            botName={entry?.connection.handle ?? "bot"}
            botEmoji={entry?.connection.avatarEmoji ?? "🤖"}
            isPrivate={entry !== undefined && entry.grant.allowPublish === false}
            onOpenThread={onOpenThread}
          />
        );
      })}
    </div>
  );
}
