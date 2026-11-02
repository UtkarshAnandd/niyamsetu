import { z } from "zod";

// Shared zod schemas used by every route.

// Route paths like /applications/:id
export const idParams = z.object({ id: z.string().min(1) });

// ?limit on every list endpoint: default 50, min 1, max 200.
export const limitField = z.coerce.number().int().min(1).max(200).default(50);
export const limitQuery = z.object({ limit: limitField });
