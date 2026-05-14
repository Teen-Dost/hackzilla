"use client";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";

function makeClient() {
  const demo = typeof window !== "undefined" && process.env.NEXT_PUBLIC_LEARNLOOP_DEMO === "1";
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: demo ? 5 * 60_000 : 60_000,
        refetchOnWindowFocus: false,
      },
    },
  });
}

export function QueryProvider({ children }: { children: React.ReactNode }) {
  const [client] = React.useState(makeClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
