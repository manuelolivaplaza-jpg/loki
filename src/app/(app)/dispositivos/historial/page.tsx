"use client";

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { DeviceHistory } from "@/components/devices/device-history";

function HistoryByQuery(): React.JSX.Element {
  const searchParams = useSearchParams();
  const pc = searchParams.get("pc");
  return <DeviceHistory deviceId={pc} />;
}

export default function HistorialPcPage(): React.JSX.Element {
  return (
    <React.Suspense fallback={<div className="min-h-[calc(100dvh-68px)]" />}>
      <div className="mx-auto w-full max-w-xl space-y-6 px-4 py-6 md:py-8">
        <HistoryByQuery />
      </div>
    </React.Suspense>
  );
}
