/**
 * Push React Query invalidation hints to the socket server — WHY: avoids hammering Next with poll loops.
 * When `SOCKET_SERVER_INTERNAL_URL` / `SOCKET_INTERNAL_SECRET` are unset, this is a no-op (HTTP polling fallback).
 */

export type InvalidateQueryKey = (string | number | boolean | null)[];

export type InvalidatePublishPayload = {
  targets?: { userIds: string[]; keys: InvalidateQueryKey[] }[];
  broadcastKeys?: InvalidateQueryKey[];
};

export async function publishQueryInvalidate(payload: InvalidatePublishPayload): Promise<void> {
  const base = process.env.SOCKET_SERVER_INTERNAL_URL?.replace(/\/$/, "");
  const secret = process.env.SOCKET_INTERNAL_SECRET;
  if (!base || !secret) return;
  const hasWork =
    (payload.targets?.length ?? 0) > 0 || (payload.broadcastKeys?.length ?? 0) > 0;
  if (!hasWork) return;

  try {
    await fetch(`${base}/internal/publish`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-socket-internal-secret": secret,
      },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch {
    /* non-fatal: polling still works */
  }
}
