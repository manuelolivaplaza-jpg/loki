import * as React from "react";
import { ProyectosTabs } from "@/app/(app)/proyectos/proyectos-tabs";

function ProyectosFallback(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-6xl px-4 py-4">
      <div
        aria-hidden="true"
        className="flex rounded-full bg-surface-soft p-1"
      >
        <span className="h-9 flex-1 rounded-full bg-background shadow-float" />
        <span className="h-9 flex-1" />
      </div>
    </div>
  );
}

export default function ProyectosPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<ProyectosFallback />}>
      <ProyectosTabs defaultTab="proyectos" />
    </React.Suspense>
  );
}
