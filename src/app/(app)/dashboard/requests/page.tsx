import { Suspense } from "react";
import { getRequestsFeed } from "@/features/help-requests/actions";
import {
  RequestsFeedClient,
  type RequestsFeedInitialPage,
} from "@/features/help-requests/components/requests-feed-client";

function FeedFallback() {
  return (
    <div className="mx-auto max-w-3xl space-y-6 py-8">
      <div className="h-8 w-48 animate-pulse rounded-md bg-muted" />
      <div className="h-10 w-full animate-pulse rounded-md bg-muted" />
      <div className="space-y-3">
        {[1, 2, 3].map((i) => (
          <div key={i} className="h-28 animate-pulse rounded-xl border border-border/40 bg-muted/30" />
        ))}
      </div>
    </div>
  );
}

export default async function RequestsPage() {
  let initialFeedPage: RequestsFeedInitialPage | undefined;
  try {
    const page = await getRequestsFeed({ cursor: null, subject: undefined, q: undefined });
    initialFeedPage = { items: page.items as RequestsFeedInitialPage["items"], nextCursor: page.nextCursor };
  } catch {
    initialFeedPage = undefined;
  }

  return (
    <Suspense fallback={<FeedFallback />}>
      <RequestsFeedClient initialFeedPage={initialFeedPage} />
    </Suspense>
  );
}
