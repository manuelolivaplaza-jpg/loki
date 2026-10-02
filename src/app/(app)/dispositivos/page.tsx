"use client";

import * as React from "react";
import { DevicesView } from "@/components/devices/devices-view";

export default function DispositivosPage(): React.JSX.Element {
  return (
    <div className="mx-auto w-full max-w-xl space-y-6 px-4 py-6 md:py-8">
      <DevicesView />
    </div>
  );
}
