import { z } from 'zod';
export const outcomeSchema = z.object({
  summary: z.string().trim().min(3, 'Describe what happened.').max(2000),
  metrics: z.array(z.object({ label: z.string().trim().min(1).max(100), value: z.string().trim().min(1).max(100) })).max(10).default([]),
});
