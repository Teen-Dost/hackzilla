"use client";

import { useSocketIo } from "@/features/realtime/socket-io-provider";

/** When the socket is connected, polling is disabled (`false`); otherwise uses `intervalMs` as a fallback. */
export function useAdaptiveRefetchInterval(intervalMs: number): number | false {
  const { connected } = useSocketIo();
  return connected ? false : intervalMs;
}
