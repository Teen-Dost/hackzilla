"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Clock, MessageSquare, PanelTop, Send, Square, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { endSession, getSessionBundle, sendSessionMessage } from "@/features/help-requests/actions";
import { SessionMediaRail } from "@/features/sessions/components/session-media-rail";
import { SessionWhiteboard } from "@/features/sessions/components/session-whiteboard";
import { SessionRatingPanel } from "@/features/sessions/components/session-rating-panel";
import { ReportContentDialog } from "@/features/trust/components/report-content-dialog";
import { useSocketIo } from "@/features/realtime/socket-io-provider";
import { usePageVisible } from "@/features/realtime/use-page-visible";
import { AIShimmer } from "@/features/ai/components/ai-shimmer";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/feedback/empty-state";
import { ClientToServerEvents, ServerToClientEvents } from "@/server/socket/events";
import type { MessageNewEventPayload, SessionLiveChatMessagePayload } from "@/server/socket/events";

type SessionBundle = NonNullable<Awaited<ReturnType<typeof getSessionBundle>>>;

export function SessionRoomClient(props: {
  sessionId: string;
  initialBundle?: Awaited<ReturnType<typeof getSessionBundle>>;
}) {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);
  if (!mounted) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-1 sm:px-0">
        <AIShimmer className="h-36 w-full rounded-2xl sm:h-40" />
        <AIShimmer className="h-72 w-full rounded-2xl sm:h-64" />
      </div>
    );
  }
  return <SessionRoomInner {...props} />;
}

type SessionMessage = SessionBundle["messages"][number] & {
  pending?: boolean;
  clientMessageId?: string;
};

function mergeIncomingMessage(prev: SessionBundle | undefined, incoming: SessionLiveChatMessagePayload | SessionMessage) {
  if (!prev?.viewerId) return prev;
  if (prev.messages.some((m) => m.id === incoming.id)) return prev;

  const isMine = incoming.senderId === prev.viewerId;
  const normalized = { ...incoming, isMine };
  const optimisticIndex = prev.messages.findIndex(
    (m) => (m as SessionMessage).pending && (m as SessionMessage).senderId === incoming.senderId && m.body === incoming.body,
  );

  if (optimisticIndex >= 0) {
    const nextMessages = [...prev.messages];
    nextMessages[optimisticIndex] = normalized;
    return { ...prev, messages: nextMessages };
  }

  return { ...prev, messages: [...prev.messages, normalized] };
}

function SessionRoomInner({
  sessionId,
  initialBundle,
}: {
  sessionId: string;
  initialBundle?: Awaited<ReturnType<typeof getSessionBundle>>;
}) {
  const queryClient = useQueryClient();
  const { socket, connected } = useSocketIo();
  const [body, setBody] = React.useState("");
  const [typing, setTyping] = React.useState(false);
  const tRef = React.useRef<number | null>(null);

  const initialMeta = React.useMemo(() => {
    if (initialBundle === undefined) return null;
    if (initialBundle === null) return null;
    return { data: initialBundle, updatedAt: Date.now() };
  }, [initialBundle]);

  const pageVisible = usePageVisible();
  const pollMsFallback = 4_000;
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => getSessionBundle(sessionId),
    refetchInterval: (q) => {
      if (!pageVisible) return false;
      const d = q.state.data;
      const live = d?.status === "SCHEDULED" || d?.status === "ACTIVE";
      if (!live) return false;
      return connected ? false : pollMsFallback;
    },
    refetchOnMount: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
    retry: 1,
    staleTime: connected ? 5 * 60_000 : 15_000,
    gcTime: 1000 * 60 * 60 * 12,
    ...(initialMeta
      ? { initialData: initialMeta.data, initialDataUpdatedAt: initialMeta.updatedAt }
      : {}),
  });

  const sessionLive = query.data?.status === "SCHEDULED" || query.data?.status === "ACTIVE";

  React.useLayoutEffect(() => {
    if (!socket) return;
    const join = () => {
      socket.emit(ClientToServerEvents.SESSION_SUBSCRIBE, { sessionId });
    };
    if (!sessionLive) {
      if (socket.connected) {
        socket.emit(ClientToServerEvents.SESSION_UNSUBSCRIBE, { sessionId });
      }
      return;
    }
    if (socket.connected) join();
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
      if (socket.connected) {
        socket.emit(ClientToServerEvents.SESSION_UNSUBSCRIBE, { sessionId });
      }
    };
  }, [socket, sessionId, sessionLive]);

  React.useEffect(() => {
    if (!socket || !sessionLive) return;
    const onNew = (payload: MessageNewEventPayload) => {
      if (payload.sessionId !== sessionId) return;
      queryClient.setQueryData<SessionBundle>(["session", sessionId], (prev) => mergeIncomingMessage(prev, payload.message));
    };
    socket.on(ServerToClientEvents.MESSAGE_NEW, onNew);
    return () => {
      socket.off(ServerToClientEvents.MESSAGE_NEW, onNew);
    };
  }, [socket, sessionId, queryClient, sessionLive]);

  const send = useMutation({
    mutationFn: ({ body: messageBody, clientMessageId }: { body: string; clientMessageId: string }) =>
      sendSessionMessage({ sessionId, body: messageBody, clientMessageId }),
    onMutate: async ({ body: messageBody, clientMessageId }) => {
      const prevBundle = queryClient.getQueryData<SessionBundle>(["session", sessionId]);
      const live = prevBundle?.status === "SCHEDULED" || prevBundle?.status === "ACTIVE";
      if (!live) return { clientMessageId };
      const optimisticBody = messageBody.trim();
      if (!optimisticBody) return { clientMessageId };
      queryClient.setQueryData<SessionBundle>(["session", sessionId], (prev) => {
        if (!prev?.viewerId) return prev;
        const optimisticMessage = {
          id: clientMessageId,
          clientMessageId,
          body: optimisticBody,
          createdAt: new Date().toISOString(),
          senderId: prev.viewerId,
          senderName: "You",
          isMine: true,
          pending: true,
        } as SessionMessage;
        if (prev.messages.some((m) => m.id === clientMessageId)) return prev;
        return { ...prev, messages: [...prev.messages, optimisticMessage] };
      });
      return { clientMessageId };
    },
    onSuccess: (res, _vars, ctx) => {
      setBody("");
      if (res.message) {
        queryClient.setQueryData<SessionBundle>(["session", sessionId], (prev) => {
          if (!prev?.viewerId) return prev;
          const finalMessage = { ...res.message!, isMine: true } as SessionMessage;
          const nextMessages = prev.messages
            .map((m) => ((ctx?.clientMessageId && (m as SessionMessage).clientMessageId === ctx.clientMessageId) ? finalMessage : m))
            .filter((m, index, all) => all.findIndex((candidate) => candidate.id === m.id) === index);
          if (nextMessages.some((m) => m.id === finalMessage.id)) return { ...prev, messages: nextMessages };
          return { ...prev, messages: [...nextMessages, finalMessage] };
        });
      } else {
        void query.refetch();
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  

  const end = useMutation({
    mutationFn: () => endSession(sessionId),
    onSuccess: () => {
      toast.success("Session ended.");
      void query.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = query.data;
  const elapsed = useElapsed(data?.startedAt, data?.status === "ACTIVE");
  const submitMessage = React.useCallback(() => {
    if (!sessionLive) return;
    const messageBody = body.trim();
    if (!messageBody || send.isPending) return;
    void send.mutateAsync({ body: messageBody, clientMessageId: crypto.randomUUID() });
  }, [body, send, sessionLive]);

  if (query.isLoading) {
    return (
      <div className="mx-auto max-w-6xl space-y-4 px-1 sm:px-0">
        <AIShimmer className="h-36 w-full rounded-2xl sm:h-40" />
        <AIShimmer className="h-72 w-full rounded-2xl sm:h-64" />
      </div>
    );
  }

  if (query.isError) {
    return (
      <div className="mx-auto max-w-lg px-2">
        <EmptyState
          icon={AlertCircle}
          title="Session unavailable"
          description="We couldn’t load this room. Your link may be stale, or the network dropped mid-request."
        >
          <Button type="button" variant="glow" onClick={() => void query.refetch()} disabled={query.isFetching}>
            {query.isFetching ? "Retrying…" : "Retry"}
          </Button>
          <Button type="button" variant="outline" asChild>
            <Link href="/dashboard/sessions">All sessions</Link>
          </Button>
        </EmptyState>
      </div>
    );
  }

  if (query.isSuccess && !data) {
    return (
      <div className="mx-auto max-w-lg px-2">
        <EmptyState
          icon={MessageSquare}
          title="Session not found"
          description="You may not have access, or this room was archived after completion."
        >
          <Button variant="glow" asChild>
            <Link href="/dashboard/sessions">Back to sessions</Link>
          </Button>
        </EmptyState>
      </div>
    );
  }

  if (!data) {
    return null;
  }

  return (
    <div className="mx-auto flex min-h-0 min-w-0 max-w-6xl flex-col gap-4 lg:flex-row lg:items-stretch lg:gap-6">
      <div className="flex min-h-0 min-w-0 max-h-[85dvh] flex-1 flex-col rounded-2xl border border-border/70 bg-card/60 shadow-card backdrop-blur-sm lg:max-h-[calc(100dvh-7rem)] lg:max-w-md">
        <div className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <p className="text-xs font-medium uppercase tracking-wider text-primary">Session</p>
            <p className="truncate text-sm font-semibold">{data.requestTitle}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <ReportContentDialog target={{ targetType: "SESSION", targetId: sessionId }} label="Report" />
            <Badge variant={data.status === "ACTIVE" ? "glow" : "secondary"}>{data.status}</Badge>
          </div>
        </div>
        <SessionMediaRail className="mx-3 mt-2" sessionOpen={sessionLive} />
        <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
          {!sessionLive ? (
            <span className="ml-auto text-muted-foreground">Session ended</span>
          ) : typing ? (
            <span className="ml-auto animate-pulse text-primary">Someone is typing…</span>
          ) : connected ? (
            <span className="ml-auto text-emerald-400/90">Live chat</span>
          ) : (
            <span className="ml-auto opacity-60">Syncing…</span>
          )}
        </div>
        <ScrollArea className="min-h-0 min-w-0 flex-1 basis-0 px-3">
          <div className="space-y-2 py-3">
            <AnimatePresence initial={false}>
              {data.messages.map((m) => (
                <motion.div
                  key={m.id}
                  layout
                  initial={{ opacity: 0, y: 4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={cn(
                    "max-w-[90%] rounded-2xl border px-3 py-2 text-sm",
                    m.isMine ? "ml-auto border-primary/30 bg-primary/10" : "border-border/60 bg-muted/30",
                  )}
                >
                  <p className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">{m.senderName}</p>
                  <p className="whitespace-pre-wrap leading-relaxed">{m.body}</p>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </ScrollArea>
        <div className="border-t border-border/60 p-3">
          <div className="flex gap-2">
            <Input
              value={body}
              onChange={(e) => {
                setBody(e.target.value);
                setTyping(true);
                if (tRef.current) window.clearTimeout(tRef.current);
                tRef.current = window.setTimeout(() => setTyping(false), 700);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  submitMessage();
                }
              }}
              placeholder={sessionLive ? "Message…" : "Chat closed for this session"}
              className="bg-background/50"
              disabled={!sessionLive}
            />
            <Button size="icon" variant="glow" disabled={!sessionLive || !body.trim() || send.isPending} onClick={submitMessage}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-h-0 min-w-0 flex-[1.2] flex-col gap-4">
        <div className="grid gap-4 md:grid-cols-2">
          <Card className="border-border/70 bg-card/70 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <PanelTop className="h-4 w-4 text-primary" />
                Whiteboard
              </CardTitle>
            </CardHeader>
            <CardContent>
              <SessionWhiteboard
                sessionId={sessionId}
                readOnly={data.status !== "SCHEDULED" && data.status !== "ACTIVE"}
              />
            </CardContent>
          </Card>
          <Card className="border-border/70 bg-card/70 backdrop-blur-sm">
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-base">
                <MessageSquare className="h-4 w-4 text-primary" />
                Session tips
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Use the chat for quick explanations and the whiteboard for sketches, step-by-step work, or diagrams.</p>
              <p className="text-xs">When you wrap up, the learner can rate the session so your tutor payout is recorded.</p>
              {data.status === "ENDED" && data.tutorSessionPayoutMicrocredits ? (
                <p className="rounded-md border border-border/60 bg-muted/20 px-2 py-1.5 text-xs text-foreground/90">
                  {data.viewerId === data.tutor.id ? (
                    <>
                      <span className="font-semibold text-primary">Your payout from this session: </span>
                      {formatMicroCreditsLabel(data.tutorSessionPayoutMicrocredits)} (based on the learner’s star
                      rating).
                    </>
                  ) : (
                    <>
                      <span className="font-semibold text-primary">Tutor payout: </span>
                      {formatMicroCreditsLabel(data.tutorSessionPayoutMicrocredits)} credited to your tutor after
                      your rating.
                    </>
                  )}
                </p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {data.viewerId === data.student.id && (data.viewerCanRate || data.sessionRating != null) ? (
          <SessionRatingPanel
            sessionId={sessionId}
            viewerCanRate={data.viewerCanRate}
            sessionRatingStars={data.sessionRating?.stars ?? null}
          />
        ) : null}

        <Card className="border-border/70 bg-card/70 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4" />
              Controls
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button
              variant="destructive"
              onClick={() => void end.mutateAsync()}
              disabled={end.isPending || data.status === "ENDED"}
            >
              <Square className="mr-2 h-4 w-4" />
              Close session
            </Button>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function useElapsed(startedAt: string | null | undefined, active: boolean) {
  const [, setTick] = React.useState(0);
  React.useEffect(() => {
    if (!active || !startedAt) return;
    const id = window.setInterval(() => setTick((t) => t + 1), 1000);
    return () => window.clearInterval(id);
  }, [active, startedAt]);
  if (!startedAt || !active) return 0;
  return Math.max(0, Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000));
}

function formatElapsed(sec: number) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function formatMicroCreditsLabel(micro: string) {
  const n = Number(BigInt(micro)) / 1_000_000;
  if (!Number.isFinite(n)) return "—";
  if (n >= 10) return `~${n.toFixed(0)} credits`;
  if (n >= 1) return `~${n.toFixed(1)} credits`;
  return `~${n.toFixed(2)} credits`;
}
