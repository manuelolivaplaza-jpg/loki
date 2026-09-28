import type * as React from "react";
import { AppShell } from "@/components/shell/app-shell";

export default function AppGroupLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return <AppShell>{children}</AppShell>;
}
