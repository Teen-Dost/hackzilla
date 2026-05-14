"use client";

import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import { Clock, MessageSquare, PanelTop, Send, Sparkles, Square, Play, AlertCircle } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { endSession, getSessionBundle, sendSessionMessage, startSession } from "@/features/help-requests/actions";
import { SessionMediaRail } from "@/features/sessions/components/session-media-rail";
import { SessionWhiteboard } from "@/features/sessions/components/session-whiteboard";
import { ReportContentDialog } from "@/features/trust/components/report-content-dialog";
import { useSocketIo } from "@/features/realtime/socket-io-provider";
import { usePageVisible } from "@/features/realtime/use-page-visible";
import { AIStreamingText } from "@/features/ai/components/ai-streaming-text";
import { AIShimmer } from "@/features/ai/components/ai-shimmer";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/feedback/empty-state";
import { ClientToServerEvents, ServerToClientEvents } from "@/server/socket/events";
import type { MessageNewEventPayload } from "@/server/socket/events";

type SessionBundle = NonNullable<Awaited<ReturnType<typeof getSessionBundle>>>;

export function SessionRoomClient({
  sessionId,
  initialBundle,
}: {
  sessionId: string;
  /** From RSC when load succeeds; `null` means not found (client still refetches once). */
  initialBundle?: Awaited<ReturnType<typeof getSessionBundle>>;
}) {
  const queryClient = useQueryClient();
  const { socket, connected } = useSocketIo();
  const [body, setBody] = React.useState("");
  const [typing, setTyping] = React.useState(false);
  const tRef = React.useRef<number | null>(null);

  React.useLayoutEffect(() => {
    if (!socket) return;
    const join = () => {
      socket.emit(ClientToServerEvents.SESSION_SUBSCRIBE, { sessionId });
    };
    if (socket.connected) join();
    socket.on("connect", join);
    return () => {
      socket.off("connect", join);
      if (socket.connected) {
        socket.emit(ClientToServerEvents.SESSION_UNSUBSCRIBE, { sessionId });
      }
    };
  }, [socket, sessionId]);

  React.useEffect(() => {
    if (!socket) return;
    const onNew = (payload: MessageNewEventPayload) => {
      if (payload.sessionId !== sessionId) return;
      queryClient.setQueryData<SessionBundle>(["session", sessionId], (prev) => {
        if (!prev?.viewerId) return prev;
        if (prev.messages.some((m) => m.id === payload.message.id)) return prev;
        return {
          ...prev,
          messages: [
            ...prev.messages,
            {
              ...payload.message,
              isMine: payload.message.senderId === prev.viewerId,
            },
          ],
        };
      });
    };
    socket.on(ServerToClientEvents.MESSAGE_NEW, onNew);
    return () => {
      socket.off(ServerToClientEvents.MESSAGE_NEW, onNew);
    };
  }, [socket, sessionId, queryClient]);

  const initialMeta = React.useMemo(() => {
    if (initialBundle === undefined) return null;
    if (initialBundle === null) return null;
    return { data: initialBundle, updatedAt: Date.now() };
  }, [initialBundle]);

  const pageVisible = usePageVisible();
  const pollMs = connected ? false : 4_000;
  const query = useQuery({
    queryKey: ["session", sessionId],
    queryFn: () => getSessionBundle(sessionId),
    refetchInterval: pageVisible ? pollMs : false,
    retry: 1,
    staleTime: connected ? 120_000 : 12_000,
    gcTime: 1000 * 60 * 60 * 12,
    ...(initialMeta
      ? { initialData: initialMeta.data, initialDataUpdatedAt: initialMeta.updatedAt }
      : {}),
  });

  const send = useMutation({
    mutationFn: () => sendSessionMessage({ sessionId, body, clientMessageId: crypto.randomUUID() }),
    onSuccess: (res) => {
      setBody("");
      if (res.message) {
        queryClient.setQueryData<SessionBundle>(["session", sessionId], (prev) => {
          if (!prev?.viewerId) return prev;
          if (prev.messages.some((m) => m.id === res.message!.id)) return prev;
          return {
            ...prev,
            messages: [...prev.messages, { ...res.message!, isMine: true }],
          };
        });
      } else {
        void query.refetch();
      }
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const start = useMutation({
    mutationFn: () => startSession(sessionId),
    onSuccess: () => {
      toast.success("Session live");
      void query.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const end = useMutation({
    mutationFn: () => endSession(sessionId),
    onSuccess: () => {
      toast.success("Session wrapped — AI recap saved");
      void query.refetch();
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const data = query.data;
  const elapsed = useElapsed(data?.startedAt, data?.status === "ACTIVE");

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
    <div className="mx-auto flex min-w-0 max-w-6xl flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
      <div className="flex min-h-[min(70dvh,520px)] min-w-0 flex-1 flex-col rounded-2xl border border-border/70 bg-card/60 shadow-card backdrop-blur-sm lg:max-w-md">
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
        <SessionMediaRail className="mx-3 mt-2" />
        <div className="flex items-center gap-2 border-b border-border/40 px-4 py-2 text-xs text-muted-foreground">
          <Clock className="h-3.5 w-3.5" />
          <span className="font-mono tabular-nums">{formatElapsed(elapsed)}</span>
          {typing ? (
            <span className="ml-auto animate-pulse text-primary">Someone is typing…</span>
          ) : connected ? (
            <span className="ml-auto text-emerald-400/90">Live chat</span>
          ) : (
            <span className="ml-auto opacity-60">Syncing…</span>
          )}
        </div>
        <ScrollArea className="min-h-[280px] flex-1 px-3">
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
                  if (body.trim()) void send.mutateAsync();
                }
              }}
              placeholder="Message…"
              className="bg-background/50"
            />
            <Button size="icon" variant="glow" disabled={!body.trim() || send.isPending} onClick={() => void send.mutateAsync()}>
              <Send className="h-4 w-4" />
            </Button>
          </div>
        </div>
      </div>

      <div className="flex min-w-0 flex-[1.2] flex-col gap-4">
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
                <Sparkles className="h-4 w-4 text-primary" />
                AI co-pilot
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p>Suggested prompts: “Summarize last 5 messages”, “What misconception might exist?”</p>
              {data.aiSummary ? (
                <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-primary">Session recap</p>
                  <AIStreamingText text={data.aiSummary.content} speedMs={12} />
                </div>
              ) : (
                <p className="text-xs">Recap unlocks when the session ends.</p>
              )}
            </CardContent>
          </Card>
        </div>

        <Card className="border-border/70 bg-card/70 backdrop-blur-sm">
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-base">
              <MessageSquare className="h-4 w-4" />
              Controls
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {data.status === "SCHEDULED" ? (
              <Button variant="glow" onClick={() => void start.mutateAsync()}>
                <Play className="mr-2 h-4 w-4" />
                Go live
              </Button>
            ) : null}
            {data.status === "ACTIVE" ? (
              <Button variant="destructive" onClick={() => void end.mutateAsync()}>
                <Square className="mr-2 h-4 w-4" />
                End session
              </Button>
            ) : null}
            <Button variant="outline" asChild>
              <Link href="/dashboard/sessions">All sessions</Link>
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
