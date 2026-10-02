"use client";

import { Brain } from "lucide-react";
import { MemoryList } from "@/components/memory/memory-list";
import { EmptyState } from "@/components/ui/empty-state";
import { useWorkspaces } from "@/stores/workspace-store";

/**
 * Memoria del espacio (`/memoria`): lo que el espacio recuerda y que Loki usa
 * al responder. Se entra desde Configuración, desde Acciones rápidas y desde
 * el mensaje ("Recordar en el espacio").
 */
export default function MemoriaPage(): React.JSX.Element {
  const { currentWorkspaceId } = useWorkspaces();
  if (currentWorkspaceId === null) {
    return (
      <EmptyState
        icon={Brain}
        title="Sin espacio"
        description="Elige un espacio para ver su memoria."
      />
    );
  }
  return (
    <div className="px-4 py-4 md:px-6">
      <MemoryList wsId={currentWorkspaceId} />
    </div>
  );
}