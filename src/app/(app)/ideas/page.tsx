"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// Las ideas viven dentro de Proyectos, en la pestaña Ideas.
function IdeasRedirect(): React.JSX.Element {
  const router = useRouter();
  React.useEffect(() => {
    router.replace("/proyectos?tab=ideas");
  }, [router]);
  return <div className="min-h-dvh bg-background" aria-hidden="true" />;
}

export default function IdeasPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<div className="min-h-dvh bg-background" aria-hidden="true" />}>
      <IdeasRedirect />
    </React.Suspense>
  );
}
