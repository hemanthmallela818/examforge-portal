import { MAX_PAYLOAD_BYTES } from './constants.ts';
import { getEnv } from './env.ts';
import { statusErrorCode } from './errors.ts';
import type { Logger } from './log.ts';

function parseOrigin(rawOrigin: string | null): URL | null {
  if (!rawOrigin) return null;
  try {
    const url = new URL(rawOrigin);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url;
  } catch {
    return null;
  }
}

export function isOriginAllowed(requestOrigin: string | null, customAllowed?: string): boolean {
  if (!requestOrigin) {
    // Non-browser or direct invocation without Origin header
    return true;
  }

  const parsed = parseOrigin(requestOrigin);
  if (!parsed) return false;

  const rawAllowed = customAllowed !== undefined ? customAllowed : (getEnv('ALLOWED_ORIGINS') || '');
  const configuredOrigins = rawAllowed
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  // Fail closed when ALLOWED_ORIGINS is absent. Local development must also
  // configure its exact Vite origin instead of silently enabling localhost.
  if (configuredOrigins.length === 0) return false;

  return configuredOrigins.some((allowed) => {
    try {
      const allowedUrl = new URL(allowed);
      return (
        parsed.protocol === allowedUrl.protocol &&
        parsed.hostname.toLowerCase() === allowedUrl.hostname.toLowerCase() &&
        parsed.port === allowedUrl.port &&
        allowedUrl.pathname === '/' &&
        !allowedUrl.search &&
        !allowedUrl.hash
      );
    } catch {
      return false;
    }
  });
}

export function getCorsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('Origin') || '';
  const allowed = isOriginAllowed(origin);

  return {
    'Access-Control-Allow-Origin': allowed && origin ? origin : 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

export type Json = (body: unknown, status?: number) => Response;

// Every error response carries a correlation ID that is also written to the
// function log, so an operator can match a user's report to the server event.
export function createJson(request: Request, log: Logger): Json {
  return (body, status = 200) => {
    let payload = body;
    let correlationId: string | undefined;
    if (status >= 400 && body && typeof body === 'object' && !Array.isArray(body)) {
      const record = body as Record<string, unknown>;
      correlationId = typeof record.correlationId === 'string' ? record.correlationId : crypto.randomUUID();
      // Stable, machine-readable code (see docs/ERROR_CODES.md); explicit codes win.
      const code = typeof record.code === 'string' ? record.code : statusErrorCode(status);
      payload = { ...record, code, correlationId };
      log.error('manage_student_error', {
        correlationId,
        status,
        error: typeof record.error === 'string' ? record.error : 'unknown',
      });
    } else {
      log.info('manage_student_response', { status });
    }
    return new Response(JSON.stringify(payload), {
      status,
      headers: {
        ...getCorsHeaders(request),
        'Content-Type': 'application/json',
        ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
      },
    });
  };
}

/**
 * Streams the body with a byte ceiling (handles missing/false Content-Length
 * and chunked transfer). Returns null when the ceiling is exceeded.
 */
export async function readBoundedBody(request: Request, limit = MAX_PAYLOAD_BYTES): Promise<Uint8Array | null> {
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      totalBytes += value.byteLength;
      if (totalBytes > limit) return null;
      chunks.push(value);
    }
  }

  const rawBytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    rawBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return rawBytes;
}
