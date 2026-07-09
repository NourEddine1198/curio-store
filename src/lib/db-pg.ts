import { PrismaClient } from "@/generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

// Dedicated Prisma client that talks to Neon over a normal TCP (node-postgres)
// connection instead of the Neon HTTP driver.
//
// WHY THIS EXISTS: the Neon *HTTP* driver (used by the main `db` client)
// occasionally mangles request bodies that contain 4-byte characters like
// emoji, throwing a "hex escape" parse error. Our page content is full of
// emoji, so content WRITES go through this pg client, which doesn't have
// that bug. Reads can stay on the fast HTTP client.
const globalForPrismaPg = globalThis as unknown as { prismaPg: PrismaClient };

function createClient() {
  const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
  return new PrismaClient({ adapter });
}

export const dbPg = globalForPrismaPg.prismaPg || createClient();

if (process.env.NODE_ENV !== "production") globalForPrismaPg.prismaPg = dbPg;
