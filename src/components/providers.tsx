"use client";

import * as React from "react";
import { ThemeProvider } from "next-themes";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AuthListener } from "@/components/auth/auth-listener";
import { DeepLinks } from "@/components/pwa/deep-links";
import { RegisterSw } from "@/components/pwa/register-sw";

type ProvidersProps = {
  children: React.ReactNode;
}

export function Providers({ children }: ProvidersProps): React.JSX.Element {
  const [queryClient] = React.useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000,
            refetchOnWindowFocus: false,
          },
        },
      }),
  );

  return (
    <ThemeProvider attribute="class" defaultTheme="light" enableSystem={false}>
      <QueryClientProvider client={queryClient}>
        <AuthListener />
        <RegisterSw />
        <DeepLinks />
        {children}
      </QueryClientProvider>
    </ThemeProvider>
  );
}
