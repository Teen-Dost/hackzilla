"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  HelpRequestStatus,
  LeaderboardScope,
  LeaderboardWindow,
  NotificationChannel,
  NotificationStatus,
  SessionStatus,
  SessionSummaryStatus,
  TransactionType,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { logger } from "@/lib/logger";
import { getServerEnv } from "@/lib/env/server";
import {
  formatSessionRecapMarkdown,
  generateSessionRecapWithGemini,
} from "@/server/ai/gemini-session-recap";
import { tutorPayoutMicrocreditsForRating } from "@/features/sessions/session-economics";
import { getLeaderboardDemoPeriodKey } from "@/lib/demo/leaderboard-period";
import { isLearnloopDemo } from "@/lib/demo/demo-flags";
import { getAppUserIdOrThrow, getAppUserOrThrow } from "@/lib/auth/app-user";
import { publishQueryInvalidate } from "@/lib/realtime/publish-invalidate";
import { publishSessionChatMessage } from "@/lib/realtime/publish-session-chat";
import { createHelpRequestSchema } from "@/features/help-requests/schema";
import { mockCategorize } from "@/features/help-requests/ai-mock";

const feedLimit = 20;

function serializeRequest(row: {
  id: string;
  title: string;
  body: string;
  subjectSlug: string;
  topicSlug: string | null;
  urgency: string;
  preferredDurationMinutes: number;
  language: string;
  status: HelpRequestStatus;
  createdAt: Date;
  author: { id: string; profile: { displayName: string; avatarUrl: string | null } | null };
  aiTags: { tag: string; confidence: unknown }[];
  _count: { interests: number };
}) {
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    subjectSlug: row.subjectSlug,
    topicSlug: row.topicSlug,
    urgency: row.urgency,
    preferredDurationMinutes: row.preferredDurationMinutes,
    language: row.language,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    author: {
      id: row.author.id,
      displayName: row.author.profile?.displayName ?? "Learner",
      avatarUrl: row.author.profile?.avatarUrl ?? null,
    },
    tags: row.aiTags.map((t) => ({ tag: t.tag, confidence: Number(t.confidence ?? 0) })),
    interestCount: row._count.interests,
  };
}

export async function createHelpRequest(raw: unknown) {
  const user = await getAppUserOrThrow();
  const input = createHelpRequestSchema.parse(raw);

  const req = await prisma.$transaction(async (tx) => {
    const created = await tx.helpRequest.create({
      data: {
        authorId: user.id,
        title: input.title,
        body: input.body,
        subjectSlug: input.subjectSlug,
        topicSlug: input.topicSlug,
        urgency: input.urgency,
        preferredDurationMinutes: input.preferredDurationMinutes,
        language: input.language,
        status: HelpRequestStatus.OPEN,
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
      },
    });

    const tags = mockCategorize({
      title: input.title,
      body: input.body,
      subjectSlug: input.subjectSlug,
    });

    await tx.aITag.createMany({
      data: tags.map((t) => ({
        entityKind: "HELP_REQUEST" as const,
        entityId: created.id,
        helpRequestId: created.id,
        tag: t.tag,
        confidence: t.confidence,
        model: "learnloop-mock-v1",
        promptVersion: "demo-1",
      })),
    });

    const ach = await tx.achievement.findUnique({ where: { key: "FIRST_HELP_REQUEST" } });
    if (ach) {
      await tx.userAchievement.upsert({
        where: { userId_achievementId: { userId: user.id, achievementId: ach.id } },
        create: { userId: user.id, achievementId: ach.id },
        update: {},
      });
    }

    return created;
  });

  revalidatePath("/dashboard/requests");
  await publishQueryInvalidate({
    targets: [{ userIds: [user.id], keys: [["profile-dashboard"], ["leaderboard"]] }],
    broadcastKeys: [["requests-feed"]],
  });
  return { ok: true as const, id: req.id };
}

export async function getRequestsFeed(input: { cursor?: string | null; subject?: string; q?: string }) {
  await getAppUserIdOrThrow();

  const where = {
    status: HelpRequestStatus.OPEN,
    ...(input.subject ? { subjectSlug: input.subject } : {}),
    ...(input.q
      ? {
          OR: [
            { title: { contains: input.q, mode: "insensitive" as const } },
            { body: { contains: input.q, mode: "insensitive" as const } },
          ],
        }
      : {}),
  };

  try {
    const rows = await prisma.helpRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: feedLimit + 1,
      ...(input.cursor ? { skip: 1, cursor: { id: input.cursor } } : {}),
      select: {
        id: true,
        title: true,
        body: true,
        subjectSlug: true,
        topicSlug: true,
        urgency: true,
        preferredDurationMinutes: true,
        language: true,
        status: true,
        createdAt: true,
        author: { select: { id: true, profile: { select: { displayName: true, avatarUrl: true } } } },
        aiTags: { select: { tag: true, confidence: true } },
        _count: { select: { interests: true } },
      },
    });

    let nextCursor: string | null = null;
    let list = rows;
    if (rows.length > feedLimit) {
      nextCursor = rows[feedLimit - 1]?.id ?? null;
      list = rows.slice(0, feedLimit);
    }

    return { items: list.map(serializeRequest), nextCursor };
  } catch (err) {
    if (!isLearnloopDemo()) throw err;
    console.error("[LearnLoop demo] getRequestsFeed fallback:", err);
    return { items: [], nextCursor: null as string | null };
  }
}

export async function getRequestDetail(id: string) {
  const userId = await getAppUserIdOrThrow();
  const row = await prisma.helpRequest.findUnique({
    where: { id },
    select: {
      id: true,
      title: true,
      body: true,
      subjectSlug: true,
      topicSlug: true,
      urgency: true,
      preferredDurationMinutes: true,
      language: true,
      status: true,
      createdAt: true,
      authorId: true,
      author: {
        select: {
          id: true,
          profile: { select: { displayName: true, avatarUrl: true } },
        },
      },
      aiTags: { select: { tag: true, confidence: true } },
      interests: {
        select: {
          tutorUserId: true,
          createdAt: true,
          tutor: {
            select: {
              profile: {
                select: { displayName: true, avatarUrl: true, languages: true },
              },
              tutorProfile: {
                select: {
                  headline: true,
                  averageRating: true,
                  totalRatingsCount: true,
                  teachingSubjectSlugs: true,
                  verificationStatus: true,
                },
              },
            },
          },
        },
      },
      _count: { select: { interests: true } },
    },
  });
  if (!row) return null;

  const myInterest = row.interests.some((i) => i.tutorUserId === userId);

  const base = serializeRequest({
    id: row.id,
    title: row.title,
    body: row.body,
    subjectSlug: row.subjectSlug,
    topicSlug: row.topicSlug,
    urgency: row.urgency,
    preferredDurationMinutes: row.preferredDurationMinutes,
    language: row.language,
    status: row.status,
    createdAt: row.createdAt,
    author: row.author,
    aiTags: row.aiTags,
    _count: { interests: row._count.interests },
  });

  return {
    ...base,
    fullBody: row.body,
    authorId: row.authorId,
    viewerIsAuthor: userId === row.authorId,
    myInterest,
    interests: row.interests.map((i) => ({
      tutorUserId: i.tutorUserId,
      displayName: i.tutor.profile?.displayName ?? "Tutor",
      avatarUrl: i.tutor.profile?.avatarUrl ?? null,
      headline: i.tutor.tutorProfile?.headline ?? "",
      createdAt: i.createdAt.toISOString(),
      avgRating: i.tutor.tutorProfile?.averageRating != null ? Number(i.tutor.tutorProfile.averageRating) : null,
      ratingCount: i.tutor.tutorProfile?.totalRatingsCount ?? 0,
      tutorLanguages: Array.isArray(i.tutor.profile?.languages) ? (i.tutor.profile!.languages as string[]) : [],
      teachingSubjects: Array.isArray(i.tutor.tutorProfile?.teachingSubjectSlugs)
        ? (i.tutor.tutorProfile!.teachingSubjectSlugs as string[])
        : [],
      verificationStatus: i.tutor.tutorProfile?.verificationStatus ?? "NONE",
    })),
  };
}

export async function expressInterest(requestId: string) {
  const user = await getAppUserOrThrow();
  const req = await prisma.helpRequest.findFirst({
    where: { id: requestId, status: HelpRequestStatus.OPEN },
    select: { id: true, title: true, authorId: true },
  });
  if (!req) throw new Error("Request not available");
  if (req.authorId === user.id) throw new Error("Cannot express interest on own request");

  await prisma.$transaction(async (tx) => {
    await tx.helpRequestInterest.upsert({
      where: { requestId_tutorUserId: { requestId, tutorUserId: user.id } },
      create: { requestId, tutorUserId: user.id },
      update: {},
    });

    await tx.notification.create({
      data: {
        userId: req.authorId,
        channel: NotificationChannel.IN_APP,
        status: NotificationStatus.UNREAD,
        type: "TUTOR_INTEREST",
        title: "A tutor is interested",
        body: `${user.profile?.displayName ?? "Someone"} wants to help with: ${req.title}`,
        payload: { requestId, tutorUserId: user.id },
      },
    });
  });

  revalidatePath("/dashboard/requests");
  revalidatePath(`/dashboard/requests/${requestId}`);
  await publishQueryInvalidate({
    targets: [
      { userIds: [req.authorId], keys: [["notifications"], ["request-detail", requestId], ["requests-feed"]] },
      { userIds: [user.id], keys: [["request-detail", requestId], ["requests-feed"]] },
    ],
  });
  return { ok: true as const };
}

export async function withdrawInterest(requestId: string) {
  const user = await getAppUserOrThrow();
  const req = await prisma.helpRequest.findUnique({
    where: { id: requestId },
    select: { authorId: true },
  });
  await prisma.helpRequestInterest.deleteMany({
    where: { requestId, tutorUserId: user.id },
  });
  revalidatePath("/dashboard/requests");
  revalidatePath(`/dashboard/requests/${requestId}`);
  if (req) {
    await publishQueryInvalidate({
      targets: [
        { userIds: [req.authorId, user.id], keys: [["request-detail", requestId], ["requests-feed"]] },
      ],
    });
  }
  return { ok: true as const };
}

const DEMO_BOT_CLERK_ID = "demo_bot_clerk_learnloop";

/** Solo-demo: seed bot tutor expresses interest on your open request. */
export async function simulateBotInterest(requestId: string) {
  const user = await getAppUserOrThrow();
  const bot = await prisma.user.findUnique({ where: { clerkUserId: DEMO_BOT_CLERK_ID } });
  if (!bot) throw new Error("Run `npx prisma db seed` to create the demo bot tutor.");

  const req = await prisma.helpRequest.findFirst({
    where: { id: requestId },
    select: { authorId: true, status: true },
  });
  if (!req || req.authorId !== user.id) throw new Error("Only the author can run demo interest");
  if (req.status !== HelpRequestStatus.OPEN) throw new Error("Request not open");

  await prisma.helpRequestInterest.upsert({
    where: { requestId_tutorUserId: { requestId, tutorUserId: bot.id } },
    create: { requestId, tutorUserId: bot.id },
    update: {},
  });

  revalidatePath("/dashboard/requests");
  revalidatePath(`/dashboard/requests/${requestId}`);
  await publishQueryInvalidate({
    targets: [{ userIds: [user.id], keys: [["request-detail", requestId], ["requests-feed"]] }],
  });
  return { ok: true as const };
}

const matchSchema = z.object({ requestId: z.string().cuid(), tutorUserId: z.string().cuid() });

export async function matchTutor(raw: unknown) {
  const user = await getAppUserOrThrow();
  const { requestId, tutorUserId } = matchSchema.parse(raw);

  const req = await prisma.helpRequest.findFirst({
    where: { id: requestId },
    select: { id: true, authorId: true, title: true, status: true },
  });
  if (!req || req.authorId !== user.id) throw new Error("Only the author can match");
  if (req.status !== HelpRequestStatus.OPEN) throw new Error("Request is not open");

  const session = await prisma.$transaction(async (tx) => {
    await tx.helpRequest.update({
      where: { id: requestId },
      data: {
        status: HelpRequestStatus.MATCHED,
        acceptedTutorId: tutorUserId,
      },
    });

    const s = await tx.session.create({
      data: {
        helpRequestId: requestId,
        studentId: req.authorId,
        tutorId: tutorUserId,
        status: SessionStatus.SCHEDULED,
      },
    });

    await tx.notification.create({
      data: {
        userId: tutorUserId,
        channel: NotificationChannel.IN_APP,
        status: NotificationStatus.UNREAD,
        type: "REQUEST_MATCHED",
        title: "You were matched",
        body: `A session is ready for: ${req.title}`,
        payload: { requestId, sessionId: s.id },
      },
    });

    return s;
  });

  revalidatePath("/dashboard/requests");
  revalidatePath("/dashboard/sessions");
  revalidatePath(`/dashboard/sessions/${session.id}`);
  await publishQueryInvalidate({
    targets: [
      {
        userIds: [req.authorId],
        keys: [
          ["request-detail", requestId],
          ["requests-feed"],
          ["my-sessions"],
          ["profile-dashboard"],
          ["leaderboard"],
        ],
      },
      {
        userIds: [tutorUserId],
        keys: [["notifications"], ["request-detail", requestId], ["requests-feed"], ["my-sessions"]],
      },
    ],
  });
  return { ok: true as const, sessionId: session.id };
}

export async function getMySessions() {
  const userId = await getAppUserIdOrThrow();
  const rows = await prisma.session.findMany({
    where: { OR: [{ studentId: userId }, { tutorId: userId }] },
    orderBy: { updatedAt: "desc" },
    take: 30,
    select: {
      id: true,
      status: true,
      studentId: true,
      tutorId: true,
      updatedAt: true,
      helpRequest: { select: { title: true, subjectSlug: true } },
      student: { select: { profile: { select: { displayName: true } } } },
      tutor: { select: { profile: { select: { displayName: true } } } },
    },
  });
  return rows.map((s) => ({
    id: s.id,
    status: s.status,
    title: s.helpRequest.title,
    subjectSlug: s.helpRequest.subjectSlug,
    updatedAt: s.updatedAt.toISOString(),
    role: s.studentId === userId ? ("student" as const) : ("tutor" as const),
    peerName:
      s.studentId === userId ? s.tutor.profile?.displayName ?? "Tutor" : s.student.profile?.displayName ?? "Student",
  }));
}

export async function listNotifications() {
  const userId = await getAppUserIdOrThrow();
  const rows = await prisma.notification.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: 40,
  });
  return rows.map((n) => ({
    id: n.id,
    type: n.type,
    title: n.title,
    body: n.body,
    status: n.status,
    createdAt: n.createdAt.toISOString(),
    payload: n.payload,
  }));
}

export async function markNotificationRead(id: string) {
  const userId = await getAppUserIdOrThrow();
  await prisma.notification.updateMany({
    where: { id, userId },
    data: { status: NotificationStatus.READ, readAt: new Date() },
  });
  revalidatePath("/dashboard");
  await publishQueryInvalidate({
    targets: [{ userIds: [userId], keys: [["notifications"]] }],
  });
  return { ok: true as const };
}

export async function markAllNotificationsRead() {
  const userId = await getAppUserIdOrThrow();
  await prisma.notification.updateMany({
    where: { userId, status: NotificationStatus.UNREAD },
    data: { status: NotificationStatus.READ, readAt: new Date() },
  });
  await publishQueryInvalidate({
    targets: [{ userIds: [userId], keys: [["notifications"]] }],
  });
  return { ok: true as const };
}

export async function sendSessionMessage(raw: unknown) {
  const userId = await getAppUserIdOrThrow();
  const schema = z.object({
    sessionId: z.string().cuid(),
    body: z.string().min(1).max(8000),
    clientMessageId: z.string().uuid(),
  });
  const input = schema.parse(raw);

  const session = await prisma.session.findFirst({
    where: {
      id: input.sessionId,
      OR: [{ studentId: userId }, { tutorId: userId }],
      status: { in: [SessionStatus.SCHEDULED, SessionStatus.ACTIVE] },
    },
  });
  if (!session) throw new Error("Session not found");

  const [created, profile] = await Promise.all([
    prisma.message.create({
      data: {
        sessionId: input.sessionId,
        senderId: userId,
        body: input.body,
        clientMessageId: input.clientMessageId,
      },
      select: { id: true, body: true, createdAt: true, senderId: true },
    }),
    prisma.profile.findUnique({ where: { userId }, select: { displayName: true } }),
  ]);

  const message = {
    id: created.id,
    body: created.body,
    createdAt: created.createdAt.toISOString(),
    senderId: created.senderId,
    senderName: profile?.displayName ?? "User",
  };

  void publishSessionChatMessage({ sessionId: input.sessionId, message });

  revalidatePath(`/dashboard/sessions/${input.sessionId}`);
  await publishQueryInvalidate({
    targets: [
      {
        userIds: [session.studentId, session.tutorId],
        keys: [["session", input.sessionId]],
      },
    ],
  });
  return { ok: true as const, message };
}

export async function getSessionBundle(sessionId: string) {
  const userId = await getAppUserIdOrThrow();
  const session = await prisma.session.findFirst({
    where: {
      id: sessionId,
      OR: [{ studentId: userId }, { tutorId: userId }],
    },
    select: {
      id: true,
      status: true,
      startedAt: true,
      endedAt: true,
      helpRequest: { select: { title: true } },
      student: {
        select: {
          id: true,
          profile: { select: { displayName: true, avatarUrl: true } },
          presence: { select: { status: true } },
        },
      },
      tutor: {
        select: {
          id: true,
          profile: { select: { displayName: true, avatarUrl: true } },
          presence: { select: { status: true } },
        },
      },
      messages: {
        orderBy: { createdAt: "asc" },
        take: 120,
        select: {
          id: true,
          body: true,
          createdAt: true,
          senderId: true,
          sender: { select: { profile: { select: { displayName: true } } } },
        },
      },
      summaries: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { content: true, status: true },
      },
      ratings: {
        select: { fromUserId: true, stars: true, comment: true, createdAt: true },
        take: 8,
      },
    },
  });
  if (!session) return null;

  const studentRating = session.ratings.find((r) => r.fromUserId === session.student.id) ?? null;
  const viewerCanRate =
    userId === session.student.id && session.status === SessionStatus.ENDED && !studentRating;
  const payoutMicro =
    studentRating != null ? tutorPayoutMicrocreditsForRating(studentRating.stars) : null;

  return {
    viewerId: userId,
    id: session.id,
    status: session.status,
    startedAt: session.startedAt?.toISOString() ?? null,
    endedAt: session.endedAt?.toISOString() ?? null,
    requestTitle: session.helpRequest.title,
    student: {
      id: session.student.id,
      name: session.student.profile?.displayName ?? "Student",
      avatarUrl: session.student.profile?.avatarUrl ?? null,
      presence: session.student.presence?.status ?? "OFFLINE",
    },
    tutor: {
      id: session.tutor.id,
      name: session.tutor.profile?.displayName ?? "Tutor",
      avatarUrl: session.tutor.profile?.avatarUrl ?? null,
      presence: session.tutor.presence?.status ?? "OFFLINE",
    },
    messages: session.messages.map((m) => ({
      id: m.id,
      body: m.body,
      createdAt: m.createdAt.toISOString(),
      senderId: m.senderId,
      senderName: m.sender.profile?.displayName ?? "User",
      isMine: m.senderId === userId,
    })),
    aiSummary: session.summaries[0]
      ? { content: session.summaries[0].content, status: session.summaries[0].status }
      : null,
    sessionRating: studentRating
      ? {
          stars: studentRating.stars,
          comment: studentRating.comment,
          createdAt: studentRating.createdAt.toISOString(),
        }
      : null,
    viewerCanRate,
    tutorSessionPayoutMicrocredits: payoutMicro != null ? payoutMicro.toString() : null,
  };
}

export async function startSession(sessionId: string) {
  const userId = await getAppUserIdOrThrow();
  await prisma.session.updateMany({
    where: { id: sessionId, OR: [{ studentId: userId }, { tutorId: userId }], status: SessionStatus.SCHEDULED },
    data: { status: SessionStatus.ACTIVE, startedAt: new Date() },
  });
  const s = await prisma.session.findFirst({
    where: { id: sessionId, OR: [{ studentId: userId }, { tutorId: userId }] },
    select: { studentId: true, tutorId: true, helpRequestId: true },
  });
  if (s) {
    await publishQueryInvalidate({
      targets: [
        {
          userIds: [s.studentId, s.tutorId],
          keys: [["session", sessionId], ["my-sessions"], ["request-detail", s.helpRequestId]],
        },
      ],
    });
  }
  revalidatePath(`/dashboard/sessions/${sessionId}`);
  return { ok: true as const };
}

export async function endSession(sessionId: string) {
  const userId = await getAppUserIdOrThrow();
  const s = await prisma.session.findFirst({
    where: { id: sessionId, OR: [{ studentId: userId }, { tutorId: userId }] },
    include: {
      helpRequest: { select: { title: true, body: true, subjectSlug: true } },
      messages: {
        orderBy: { createdAt: "asc" },
        take: 200,
        select: {
          body: true,
          sender: { select: { profile: { select: { displayName: true } } } },
        },
      },
    },
  });
  if (!s) throw new Error("Not found");
  if (s.status === SessionStatus.ENDED) {
    return { ok: true as const };
  }
  if (s.status !== SessionStatus.ACTIVE) {
    throw new Error("Session must be active to end");
  }

  await prisma.$transaction([
    prisma.session.update({
      where: { id: sessionId },
      data: { status: SessionStatus.ENDED, endedAt: new Date() },
    }),
    prisma.helpRequest.update({
      where: { id: s.helpRequestId },
      data: { status: HelpRequestStatus.COMPLETED },
    }),
    prisma.tutorProfile.updateMany({
      where: { userId: s.tutorId },
      data: { completedSessionCount: { increment: 1 } },
    }),
  ]);

  const messageLines = s.messages.map((m) => ({
    speaker: m.sender.profile?.displayName ?? "Participant",
    body: m.body,
  }));

  let recapPayload = await generateSessionRecapWithGemini({
    requestTitle: s.helpRequest.title,
    requestBody: s.helpRequest.body,
    subjectSlug: s.helpRequest.subjectSlug,
    messages: messageLines,
  });

  let hasGeminiKey = false;
  try {
    hasGeminiKey = Boolean(getServerEnv().GEMINI_API_KEY);
  } catch {
    hasGeminiKey = false;
  }

  let modelLabel: string;
  let content: string;
  let keyPoints: string[];

  if (recapPayload) {
    modelLabel = "google-gemini";
    content = formatSessionRecapMarkdown(recapPayload);
    keyPoints = recapPayload.keyPoints;
  } else {
    modelLabel = "learnloop-fallback-v1";
    if (hasGeminiKey) {
      content = [
        "## Session recap",
        "",
        "**GEMINI_API_KEY** is set, but the live recap did not succeed (model blocked the request, invalid JSON, or an API error).",
        "",
        "### What to try",
        "",
        "- Restart `next dev` after editing `.env`, then end a session again.",
        "- In the terminal, search logs for **`gemini.session_recap`** to see the HTTP status or parse error.",
        "- Optionally set **`GEMINI_MODEL=gemini-1.5-flash`** if your key cannot access newer models.",
      ].join("\n");
      keyPoints = [
        "Gemini configured — inspect server logs: gemini.session_recap",
        "Retry after restart or try GEMINI_MODEL=gemini-1.5-flash",
      ];
    } else {
      content = [
        "## Session recap",
        "",
        "We could not reach the live AI recap service (add a **GEMINI_API_KEY** in your environment for Gemini-powered insights).",
        "",
        "### Offline placeholder",
        "",
        "- Core topics from the chat were not auto-summarized in this run.",
        "- Ask your tutor for a one-line takeaway, or re-open the thread from **All sessions**.",
      ].join("\n");
      keyPoints = ["Recap unavailable — set GEMINI_API_KEY", "Session marked complete in the ledger"];
    }
    logger.info("session.end.fallback_recap", { sessionId, hasGeminiKey });
  }

  await prisma.sessionSummary.create({
    data: {
      sessionId,
      status: SessionSummaryStatus.COMPLETED,
      content,
      keyPoints,
      model: modelLabel,
      promptVersion: "session-recap-v2",
    },
  });

  revalidatePath(`/dashboard/sessions/${sessionId}`);
  await publishQueryInvalidate({
    targets: [
      {
        userIds: [s.studentId, s.tutorId],
        keys: [
          ["session", sessionId],
          ["my-sessions"],
          ["request-detail", s.helpRequestId],
          ["profile-dashboard"],
          ["leaderboard"],
        ],
      },
    ],
  });
  return { ok: true as const };
}

const sessionRatingSchema = z.object({
  sessionId: z.string().cuid(),
  stars: z.number().int().min(1).max(5),
  comment: z.string().max(2000).optional(),
});

export async function submitSessionRating(raw: unknown) {
  const user = await getAppUserOrThrow();
  const input = sessionRatingSchema.parse(raw);

  const session = await prisma.session.findFirst({
    where: {
      id: input.sessionId,
      studentId: user.id,
      status: SessionStatus.ENDED,
    },
    select: { id: true, tutorId: true },
  });
  if (!session) throw new Error("Session not found or rating is not open yet");

  const existing = await prisma.rating.findUnique({
    where: { sessionId_fromUserId: { sessionId: input.sessionId, fromUserId: user.id } },
  });
  if (existing) throw new Error("You already rated this session");

  const idempotencyKey = `tutor-session-payout:${input.sessionId}`;
  const dupPayout = await prisma.transaction.findUnique({ where: { idempotencyKey } });
  if (dupPayout) {
    return { ok: true as const, tutorPayoutMicrocredits: dupPayout.amountMicrocredits.toString() };
  }

  const amountMicro = tutorPayoutMicrocreditsForRating(input.stars);
  const commentTrim = input.comment?.trim();

  await prisma.$transaction(async (tx) => {
    await tx.rating.create({
      data: {
        sessionId: input.sessionId,
        fromUserId: user.id,
        toUserId: session.tutorId,
        stars: input.stars,
        comment: commentTrim ? commentTrim : null,
      },
    });

    const agg = await tx.rating.aggregate({
      where: { toUserId: session.tutorId },
      _avg: { stars: true },
      _count: { _all: true },
    });

    await tx.tutorProfile.updateMany({
      where: { userId: session.tutorId },
      data: {
        ...(agg._avg.stars != null ? { averageRating: agg._avg.stars } : {}),
        totalRatingsCount: agg._count._all,
      },
    });

    let wallet = await tx.creditWallet.findUnique({ where: { userId: session.tutorId } });
    if (!wallet) {
      wallet = await tx.creditWallet.create({ data: { userId: session.tutorId } });
    }

    const nextBalance = wallet.balanceMicrocredits + amountMicro;
    await tx.transaction.create({
      data: {
        walletId: wallet.id,
        actorUserId: user.id,
        type: TransactionType.CREDIT,
        amountMicrocredits: amountMicro,
        balanceAfterMicrocredits: nextBalance,
        idempotencyKey,
        referenceKind: "SESSION_RATING",
        referenceId: input.sessionId,
        metadata: { stars: input.stars },
      },
    });

    await tx.creditWallet.update({
      where: { id: wallet.id },
      data: {
        balanceMicrocredits: nextBalance,
        version: { increment: 1 },
      },
    });
  });

  revalidatePath(`/dashboard/sessions/${input.sessionId}`);
  revalidatePath("/dashboard/profile");
  await publishQueryInvalidate({
    targets: [
      {
        userIds: [session.tutorId, user.id],
        keys: [["session", input.sessionId], ["my-sessions"], ["profile-dashboard"], ["leaderboard"]],
      },
    ],
  });

  return { ok: true as const, tutorPayoutMicrocredits: amountMicro.toString() };
}

export async function getLeaderboardRows() {
  await getAppUserIdOrThrow();
  const periodKey = getLeaderboardDemoPeriodKey();

  try {
    const rows = await prisma.leaderboardStats.findMany({
      where: { window: LeaderboardWindow.MONTHLY, periodKey, scope: LeaderboardScope.GLOBAL },
      orderBy: { points: "desc" },
      take: 12,
      include: {
        user: {
          select: {
            id: true,
            profile: { select: { displayName: true, avatarUrl: true } },
            tutorProfile: { select: { headline: true } },
          },
        },
      },
    });

    if (rows.length >= 3) {
      return rows.map((r, i) => ({
        rank: i + 1,
        userId: r.userId,
        name: r.user.profile?.displayName ?? "Learner",
        avatarUrl: r.user.profile?.avatarUrl ?? null,
        points: r.points,
        streak: 0,
        tier: i === 0 ? "gold" : i === 1 ? "silver" : i === 2 ? "bronze" : "standard",
      }));
    }
  } catch (e) {
    if (!isLearnloopDemo()) throw e;
    console.error("[LearnLoop demo] leaderboard fallback:", e);
  }

  /** Demo fallback when DB empty — judges still see a podium. */
  return [
    { rank: 1, userId: "demo-1", name: "Morgan Chen", avatarUrl: null, points: 2840, streak: 14, tier: "gold" as const },
    { rank: 2, userId: "demo-2", name: "Riley Park", avatarUrl: null, points: 2510, streak: 9, tier: "silver" as const },
    { rank: 3, userId: "demo-3", name: "Jordan Lee", avatarUrl: null, points: 2395, streak: 21, tier: "bronze" as const },
    { rank: 4, userId: "demo-4", name: "Casey Ali", avatarUrl: null, points: 1980, streak: 4, tier: "standard" as const },
    { rank: 5, userId: "demo-5", name: "Sam Rivera", avatarUrl: null, points: 1760, streak: 6, tier: "standard" as const },
  ];
}

export async function getProfileDashboard() {
  const user = await getAppUserOrThrow();
  const since = new Date(Date.now() - 28 * 24 * 60 * 60 * 1000);
  const [authored, sessionsTaught, sessionsLearned, achievements, recentTaught] = await Promise.all([
    prisma.helpRequest.count({ where: { authorId: user.id } }),
    prisma.session.count({ where: { tutorId: user.id, status: "ENDED" } }),
    prisma.session.count({ where: { studentId: user.id, status: "ENDED" } }),
    prisma.userAchievement.findMany({
      where: { userId: user.id },
      include: { achievement: true },
      orderBy: { earnedAt: "desc" },
      take: 8,
    }),
    prisma.session.count({
      where: { tutorId: user.id, status: "ENDED", endedAt: { gte: since } },
    }),
  ]);

  const slugs = Array.isArray(user.profile?.learningSubjectSlugs) ? (user.profile!.learningSubjectSlugs as string[]) : [];
  const strengths = mockCategorize({
    title: "Profile",
    body: user.profile?.bio ?? user.tutorProfile?.headline ?? "peer learning",
    subjectSlug: slugs[0] ?? "general",
  }).map((t) => t.tag);

  return {
    user: {
      id: user.id,
      displayName: user.profile?.displayName ?? "Learner",
      bio: user.profile?.bio,
      avatarUrl: user.profile?.avatarUrl,
      campusSlug: user.profile?.campusSlug,
      institutionVerificationEmail: user.profile?.institutionVerificationEmail ?? null,
      institutionVerifiedAt: user.profile?.institutionVerifiedAt?.toISOString() ?? null,
      headline: user.tutorProfile?.headline,
      avgRating: user.tutorProfile?.averageRating ? Number(user.tutorProfile.averageRating) : null,
      completedSessions: user.tutorProfile?.completedSessionCount ?? 0,
    },
    stats: {
      doubtsPosted: authored,
      sessionsTaught,
      sessionsLearned,
      teachingStreakSessions: Math.min(12, recentTaught),
    },
    achievements: achievements.map((a) => ({
      key: a.achievement.key,
      name: a.achievement.name,
      earnedAt: a.earnedAt.toISOString(),
    })),
    aiStrengths: strengths,
  };
}
