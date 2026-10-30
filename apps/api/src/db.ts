import { PrismaClient } from "@prisma/client";

// One shared Prisma client for the whole API.
export const prisma = new PrismaClient();
