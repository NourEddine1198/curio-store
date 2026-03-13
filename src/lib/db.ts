import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// What this does:
// Creates ONE database connection that the whole app shares.
// Prisma v7 uses a "driver adapter" to talk to Postgres directly.
// In development, Next.js reloads code often — this singleton pattern
// prevents creating a new connection on every reload.

const globalForPrisma = globalThis as unknown as { prisma: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({ adapter });
}

export const db = globalForPrisma.prisma || createClient();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
