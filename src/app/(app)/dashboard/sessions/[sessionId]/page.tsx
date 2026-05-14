import { SessionRoomClient } from "@/features/sessions/components/session-room-client";

export default async function SessionRoomPage({ params }: { params: Promise<{ sessionId: string }> }) {
  const { sessionId } = await params;
  return <SessionRoomClient sessionId={sessionId} />;
}
