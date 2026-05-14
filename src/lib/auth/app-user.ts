import { auth, currentUser } from "@clerk/nextjs/server";
import { prisma } from "@/lib/db/prisma";
import { upsertUserFromClerkSync } from "@/lib/auth/sync-clerk-user";

export class AuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthError";
  }
}

const appUserInclude = {
  profile: true,
  tutorProfile: true,
  wallet: true,
  presence: true,
} as const;

/** Resolves Clerk session → internal `User` row (webhook or JIT on first request). */
export async function getAppUser() {
  const { userId: clerkUserId } = await auth();
  if (!clerkUserId) return null;

  const load = () =>
    prisma.user.findFirst({
      where: { clerkUserId, deletedAt: null },
      include: appUserInclude,
    });

  let user = await load();
  if (user) return user;

  const clerk = await currentUser();
  await upsertUserFromClerkSync({
    id: clerkUserId,
    primaryEmail:
      clerk?.primaryEmailAddress?.emailAddress ??
      clerk?.emailAddresses?.[0]?.emailAddress ??
      null,
    firstName: clerk?.firstName ?? null,
    lastName: clerk?.lastName ?? null,
    imageUrl: clerk?.imageUrl ?? null,
  });

  user = await load();
  return user;
}

export async function getAppUserOrThrow() {
  const user = await getAppUser();
  if (!user) throw new AuthError("Unauthorized");
  return user;
}
