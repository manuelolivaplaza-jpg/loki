"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { ApprovalView } from "@/components/devices/approval-view";

function ApprovalByQuery(): React.JSX.Element {
  const searchParams = useSearchParams();
  // La push trae solo el id ("Tu PC necesita tu aprobación", sin datos del
  // PC): el detalle se carga aquí con la sesión del dueño.
  const cmd = searchParams.get("cmd") ?? "";
  return <ApprovalView commandId={cmd} />;
}

export default function AprobarComandoPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<div className="min-h-[calc(100dvh-68px)]" />}>
      <div className="mx-auto w-full max-w-xl px-4 py-6 md:py-8">
        <ApprovalByQuery />
      </div>
    </React.Suspense>
  );
}
