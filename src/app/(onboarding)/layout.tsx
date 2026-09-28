import type * as React from "react";
import { AuthGuard } from "@/components/auth/auth-guard";

export default function OnboardingGroupLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>): React.JSX.Element {
  return <AuthGuard>{children}</AuthGuard>;
}
