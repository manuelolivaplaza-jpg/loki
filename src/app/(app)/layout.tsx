import type * as React from "react";
import { AppShell } from "@/components/shell/app-shell";
import { AuthGuard } from "@/components/auth/auth-guard";

export default function AppGroupLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return (
    <AuthGuard>
      <AppShell>{children}</AppShell>
    </AuthGuard>
  );
}
