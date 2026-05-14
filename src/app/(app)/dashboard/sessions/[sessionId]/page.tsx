import { Suspense } from "react";
import { getSessionBundle } from "@/features/help-requests/actions";
import { SessionRoomClient } from "@/features/sessions/components/session-room-client";
import { AIShimmer } from "@/features/ai/components/ai-shimmer";

function SessionRoomFallback() {
  return (
    <div className="mx-auto max-w-6xl space-y-4 px-1 sm:px-0">
      <AIShimmer className="h-36 w-full rounded-2xl sm:h-40" />
      <AIShimmer className="h-72 w-full rounded-2xl sm:h-64" />
    </div>
  );
}

async function SessionRoomShell({ sessionId }: { sessionId: string }) {
  let initialBundle: Awaited<ReturnType<typeof getSessionBundle>> | undefined;
  try {
    initialBundle = await getSessionBundle(sessionId);
  } catch {
    initialBundle = undefined;
  }
  return <SessionRoomClient sessionId={sessionId} initialBundle={initialBundle} />;
}

export default async function SessionRoomPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return (
    <Suspense fallback={<SessionRoomFallback />}>
      <SessionRoomShell sessionId={sessionId} />
    </Suspense>
  );
}
