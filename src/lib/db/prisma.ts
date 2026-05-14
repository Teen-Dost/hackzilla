import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient | undefined };

/**
 * Singleton Prisma client — WHY: Avoid exhausting connections in Next dev HMR.
 * In production with serverless, prefer Prisma Accelerate / Data Proxy + pooler.
 */
const devQueryLog =
  process.env.NODE_ENV === "development" && process.env.PRISMA_QUERY_LOG === "1";

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: devQueryLog ? ["query", "error", "warn"] : process.env.NODE_ENV === "development" ? ["error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

export type { PrismaClient };
