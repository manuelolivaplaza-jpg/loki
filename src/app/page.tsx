"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

function RootRedirect(): React.JSX.Element {
  const router = useRouter();
  React.useEffect(() => {
    router.replace("/inicio");
  }, [router]);
  return <div className="min-h-dvh bg-background" aria-hidden="true" />;
}

export default function RootPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<div className="min-h-dvh bg-background" aria-hidden="true" />}>
      <RootRedirect />
    </React.Suspense>
  );
}
