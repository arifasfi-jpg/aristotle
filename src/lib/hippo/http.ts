import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { HttpError } from './context';

/** Uniform API error handling. Internal error text is logged, never shown; AI failures are retryable. */
export async function handle(label: string, fn: () => Promise<unknown>) {
  try {
    return NextResponse.json(await fn());
  } catch (e) {
    if (e instanceof HttpError) return NextResponse.json({ error: e.message }, { status: e.status });
    if (e instanceof ZodError) return NextResponse.json({ error: e.issues[0]?.message || 'Invalid request' }, { status: 400 });
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Hippoturtle ${label} failed:`, msg);
    if (/AI_ENGINE_NOT_CONFIGURED/.test(msg)) return NextResponse.json({ error: 'The AI engine is not configured on this server, so this could not be completed. Nothing was charged.', retryable: true }, { status: 503 });
    if (/AI_ERROR|GEMINI_ERROR|_INVALID/.test(msg)) return NextResponse.json({ error: 'This could not be completed. Nothing was lost and nothing was charged — please retry.', retryable: true }, { status: 502 });
    return NextResponse.json({ error: 'Something went wrong. Please try again.', retryable: true }, { status: 500 });
  }
}
