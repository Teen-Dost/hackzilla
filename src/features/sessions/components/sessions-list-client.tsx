"use client";

import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { motion } from "framer-motion";
import { ArrowRight, Video, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { getMySessions } from "@/features/help-requests/actions";
import { useAdaptiveRefetchInterval } from "@/features/realtime/use-adaptive-refetch-interval";
import { EmptyState } from "@/components/feedback/empty-state";
import { ListPageSkeleton } from "@/components/feedback/list-page-skeleton";
import { springSnappy } from "@/animations/variants";

export function SessionsListClient() {
  const pollMs = useAdaptiveRefetchInterval(5000);
  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ["my-sessions"],
    queryFn: () => getMySessions(),
    refetchInterval: pollMs,
  });

  if (isLoading && !data) {
    return (
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-2">
          <div className="h-8 w-40 animate-pulse rounded-md bg-muted/40" />
          <div className="h-4 w-full max-w-md animate-pulse rounded-md bg-muted/30" />
        </div>
        <ListPageSkeleton rows={5} />
      </div>
    );
  }

  if (isError) {
    return (
      <div className="mx-auto max-w-3xl">
        <EmptyState
          icon={AlertCircle}
          title="Couldn’t load sessions"
          description="The list failed to refresh. Check your connection and try again — nothing was deleted."
        >
          <Button type="button" variant="glow" onClick={() => void refetch()} disabled={isFetching}>
            {isFetching ? "Retrying…" : "Retry"}
          </Button>
        </EmptyState>
      </div>
    );
  }

  const sessions = data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
        <p className="mt-1 text-sm text-muted-foreground">Jump back into live rooms — status syncs every few seconds.</p>
      </div>

      {sessions.length === 0 ? (
        <EmptyState
          icon={Video}
          title="No sessions yet"
          description="When you match on a doubt, the session appears here with one-tap re-entry. Post a doubt from the feed to start the loop."
        >
          <Button variant="glow" asChild>
            <Link href="/dashboard/requests?compose=1">Open live feed</Link>
          </Button>
          <Button variant="outline" asChild>
            <Link href="/dashboard/requests">Browse doubts</Link>
          </Button>
        </EmptyState>
      ) : (
        <div className="space-y-3">
          {sessions.map((s, i) => (
            <motion.div
              key={s.id}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ ...springSnappy, delay: Math.min(i * 0.03, 0.18) }}
            >
              <Card className="flex flex-col gap-4 border-border/70 bg-card/70 p-4 shadow-card backdrop-blur-sm transition-shadow hover:shadow-card-hover sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{s.subjectSlug.replace(/-/g, " ")}</p>
                  <p className="mt-0.5 font-medium leading-snug">{s.title}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {s.role === "student" ? "Learning with" : "Teaching"} {s.peerName} · {s.status}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <Badge variant="secondary">{s.role}</Badge>
                  <Button size="sm" variant="glow" asChild className="touch-manipulation">
                    <Link href={`/dashboard/sessions/${s.id}`}>
                      Open
                      <ArrowRight className="ml-1 h-3.5 w-3.5" />
                    </Link>
                  </Button>
                </div>
              </Card>
            </motion.div>
          ))}
        </div>
      )}
    </div>
  );
}
