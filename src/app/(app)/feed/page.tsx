"use client";

import * as React from "react";
import { useRouter } from "next/navigation";

// El Feed se unió al Chat: las publicaciones viven en /chat/publicaciones.
function FeedRedirect(): React.JSX.Element {
  const router = useRouter();
  React.useEffect(() => {
    router.replace("/chat");
  }, [router]);
  return <div className="min-h-dvh bg-background" aria-hidden="true" />;
}

export default function FeedPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<div className="min-h-dvh bg-background" aria-hidden="true" />}>
      <FeedRedirect />
    </React.Suspense>
  );
}
