// Shared request pipeline for every action, in this fixed order:
//   origin allow-list (fail closed) -> OPTIONS/CORS -> method -> body-size cap
//   -> content type -> bounded body read -> JSON parse -> Authorization header
//   -> caller.auth.getUser -> AAL2 administrator (non-root actions)
//   -> server-owned profile role -> action lookup -> [validate] -> root
//   authority (root actions) -> validate -> handler.

import { findAction } from './actions/index.ts';
import { MAX_PAYLOAD_BYTES } from './constants.ts';
import { createSafeDbMessage } from './errors.ts';
import { createJson, getCorsHeaders, isOriginAllowed, readBoundedBody } from './http.ts';
import { createLogger } from './log.ts';
import type { ActionContext, ActionDefinition, CallerClient, ManageStudentClients, RequestBody } from './types.ts';
import { actionName } from './validation.ts';

/** Builds the Supabase clients for a request once it carries an Authorization header. */
export type ClientFactory = (authorization: string) => ManageStudentClients;

async function isRootDeveloper(caller: CallerClient): Promise<boolean> {
  const { data: isOwner, error: ownerError } = await caller.rpc('is_root_developer');
  return !ownerError && isOwner === true;
}

export async function routeRequest(request: Request, createClients: ClientFactory): Promise<Response> {
  const baseLog = createLogger();
  const originHeader = request.headers.get('Origin');

  // 1. Browser Origin Verification (strict URL parsing)
  if (originHeader && !isOriginAllowed(originHeader)) {
    baseLog.warn('origin_rejected', { status: 403 });
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(request) });
  }

  const preAuthJson = createJson(request, baseLog);
  if (request.method !== 'POST') {
    return preAuthJson({ error: 'Method not allowed' }, 405);
  }

  // 2. Payload size check via Content-Length header
  const declaredLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return preAuthJson({ error: 'Payload too large' }, 413);
  }

  // 3. Content-Type Validation
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return preAuthJson({ error: 'Content-Type must be application/json' }, 415);
  }

  // 4. Stream body with byte ceiling
  const rawBytes = await readBoundedBody(request);
  if (!rawBytes) {
    return preAuthJson({ error: 'Payload too large' }, 413);
  }
  if (rawBytes.byteLength === 0) {
    return preAuthJson({ error: 'Request body cannot be empty' }, 400);
  }

  let body: RequestBody;
  try {
    body = JSON.parse(new TextDecoder().decode(rawBytes));
  } catch {
    return preAuthJson({ error: 'Invalid JSON request body' }, 400);
  }

  // From here on every log line names the requested action.
  const action = actionName(body);
  const log = baseLog.withAction(action);
  const json = createJson(request, log);

  // 5. Authentication Header
  const authorization = request.headers.get('Authorization');
  if (!authorization) {
    return json({ error: 'Authentication required' }, 401);
  }

  const { caller, admin } = createClients(authorization);

  // 6. Cryptographically verify user with Supabase Auth
  const { data: { user }, error: userError } = await caller.auth.getUser();
  if (userError || !user) {
    return json({ error: 'Authentication required' }, 401);
  }

  // 7. Root-only account-governance and destructive actions use the owner
  // authority check below and intentionally do not require MFA. All ordinary
  // administrator actions (and unknown actions) retain the AAL2 requirement.
  const definition: ActionDefinition<unknown> | null = findAction(action);
  const isRootOnlyAction = definition?.authority === 'root';
  if (!isRootOnlyAction) {
    const { data: isAal2Admin, error: rpcError } = await caller.rpc('is_admin_aal2');
    if (rpcError || isAal2Admin !== true) {
      return json({ error: 'Active administrator access required' }, 403);
    }
  }

  // 8. Verify server-owned profile role
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle<{ role?: string }>();

  if (profileErr || profile?.role !== 'admin') {
    return json({ error: 'Administrator access required' }, 403);
  }

  // 9. Dispatch
  if (!definition) {
    return json({ error: 'Unsupported action' }, 400);
  }

  const checkAuthority = async (): Promise<Response | null> => (
    definition.authority === 'root' && !(await isRootDeveloper(caller))
      ? json({ error: 'Root developer access required' }, 403)
      : null
  );

  if (!definition.validateBeforeAuthority) {
    const denied = await checkAuthority();
    if (denied) return denied;
  }
  const input = definition.validate(body);
  if (!input.ok) {
    return json({ error: input.error }, 400);
  }
  if (definition.validateBeforeAuthority) {
    const denied = await checkAuthority();
    if (denied) return denied;
  }

  const ctx: ActionContext = {
    user,
    caller,
    admin,
    log,
    json,
    safeDbMessage: createSafeDbMessage(log),
  };
  return definition.handle(ctx, input.value);
}
