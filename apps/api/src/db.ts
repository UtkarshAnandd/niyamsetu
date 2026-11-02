import { Prisma, PrismaClient } from "@prisma/client";

// Connection-level Prisma errors: database unreachable (P1001), timed out (P1002)
// or a pooled connection that the server already closed (P1017).
export const DB_CONNECTION_CODES = ["P1001", "P1002", "P1017"];

const READS = new Set([
  "findUnique", "findUniqueOrThrow", "findFirst", "findFirstOrThrow",
  "findMany", "count", "aggregate", "groupBy", "$queryRaw",
]);
const MAX_RETRIES = 10;

const isClosedConnection = (e: unknown) =>
  e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P1017";

// One shared Prisma client for the whole API.
// After a database restart the pool still holds dead connections: a query on one fails
// with P1017 and Prisma drops it. Reads are retried so each retry gets another connection
// and the request still succeeds. Writes are not retried – the write may already have
// been committed when the connection dropped.
export const prisma = new PrismaClient().$extends({
  query: {
    async $allOperations({ operation, args, query }) {
      for (let attempt = 0; ; attempt++) {
        try {
          return await query(args);
        } catch (e) {
          if (!READS.has(operation) || !isClosedConnection(e) || attempt >= MAX_RETRIES) throw e;
        }
      }
    },
  },
});
