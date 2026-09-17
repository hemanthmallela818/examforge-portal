import { createClient } from 'jsr:@supabase/supabase-js@2';

const MAX_PAYLOAD_BYTES = 16384;

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

function getEnv(key: string): string {
  try {
    if (typeof Deno !== 'undefined' && Deno?.env?.get) {
      return Deno.env.get(key) || '';
    }
  } catch {}
  try {
    if (typeof process !== 'undefined' && process?.env) {
      return (process.env as any)[key] || '';
    }
  } catch {}
  return '';
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

function getCorsHeaders(request: Request) {
  const origin = request.headers.get('Origin') || '';
  const allowed = isOriginAllowed(origin);

  return {
    'Access-Control-Allow-Origin': allowed && origin ? origin : 'null',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

const json = (request: Request, body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...getCorsHeaders(request), 'Content-Type': 'application/json' },
  });

type ManageStudentClients = { caller: any; admin: any };

export async function handleManageStudent(
  request: Request,
  injectedClients?: ManageStudentClients,
): Promise<Response> {
  const originHeader = request.headers.get('Origin');

  // 1. Browser Origin Verification (strict URL parsing)
  if (originHeader && !isOriginAllowed(originHeader)) {
    return new Response(JSON.stringify({ error: 'Origin not allowed' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: getCorsHeaders(request) });
  }

  if (request.method !== 'POST') {
    return json(request, { error: 'Method not allowed' }, 405);
  }

  // 2. Payload size check via Content-Length header
  const declaredLength = parseInt(request.headers.get('content-length') || '0', 10);
  if (declaredLength > MAX_PAYLOAD_BYTES) {
    return json(request, { error: 'Payload too large' }, 413);
  }

  // 3. Content-Type Validation
  const contentType = request.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) {
    return json(request, { error: 'Content-Type must be application/json' }, 415);
  }

  // 4. Stream body with byte ceiling (handles missing/false Content-Length and chunked transfer)
  let rawBytes: Uint8Array;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        totalBytes += value.byteLength;
        if (totalBytes > MAX_PAYLOAD_BYTES) {
          return json(request, { error: 'Payload too large' }, 413);
        }
        chunks.push(value);
      }
    }

    rawBytes = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      rawBytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
  } else {
    rawBytes = new Uint8Array(0);
  }

  if (rawBytes.byteLength === 0) {
    return json(request, { error: 'Request body cannot be empty' }, 400);
  }

  let body: any;
  try {
    const text = new TextDecoder().decode(rawBytes);
    body = JSON.parse(text);
  } catch {
    return json(request, { error: 'Invalid JSON request body' }, 400);
  }

  // 5. Authentication Header
  const authorization = request.headers.get('Authorization');
  if (!authorization) {
    return json(request, { error: 'Authentication required' }, 401);
  }

  const url = getEnv('SUPABASE_URL');
  const anonKey = getEnv('SUPABASE_ANON_KEY');
  const serviceRoleKey = getEnv('SUPABASE_SERVICE_ROLE_KEY');

  const caller = injectedClients?.caller ?? createClient(url, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
  const admin = injectedClients?.admin ?? createClient(url, serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

  // 6. Cryptographically verify user with Supabase Auth
  const { data: { user }, error: userError } = await caller.auth.getUser();
  if (userError || !user) {
    return json(request, { error: 'Authentication required' }, 401);
  }

  // 7. Cryptographically verify caller has AAL2 administrative authorization in Postgres
  const { data: isAal2Admin, error: rpcError } = await caller.rpc('is_admin_aal2');
  if (rpcError || isAal2Admin !== true) {
    return json(request, { error: 'Multi-factor authentication (AAL2) required' }, 403);
  }

  // 8. Verify server-owned profile role
  const { data: profile, error: profileErr } = await admin
    .from('profiles')
    .select('role')
    .eq('id', user.id)
    .maybeSingle();

  if (profileErr || profile?.role !== 'admin') {
    return json(request, { error: 'Administrator access required' }, 403);
  }

  // 9. Validate Request Body
  const action = String(body?.action || '');
  if (action !== 'create' && action !== 'update-assignment') {
    return json(request, { error: 'Unsupported action' }, 400);
  }

  const className = String(body.className || '').trim();
  const section = String(body.section || '').trim();

  if (!className || className.length > 120 || !section || section.length > 60) {
    return json(request, { error: 'Class and section are required' }, 400);
  }

  // 10. Check class and section in database
  const { data: classRow, error: classErr } = await admin
    .from('classes')
    .select('sections')
    .eq('name', className)
    .maybeSingle();

  if (classErr) {
    return json(request, { error: 'Failed to verify class and section' }, 500);
  }
  if (!classRow || !Array.isArray(classRow.sections) || !classRow.sections.includes(section)) {
    return json(request, { error: 'The selected class and section do not exist' }, 400);
  }

  if (action === 'update-assignment') {
    const studentUserId = String(body.studentUserId || '').trim();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(studentUserId)) {
      return json(request, { error: 'A valid student user ID is required' }, 400);
    }

    const { data: updatedStudent, error: updateError } = await caller.rpc('admin_update_student_assignment', {
      student_user_id_param: studentUserId,
      class_name_param: className,
      section_param: section,
    });

    if (updateError) {
      return json(request, { error: 'Failed to update student assignment' }, 500);
    }
    return json(request, updatedStudent || { id: studentUserId }, 200);
  }

  const studentId = String(body.studentId || '').trim();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');

  if (!/^[A-Za-z0-9._-]{2,64}$/.test(studentId)) {
    return json(request, { error: 'Student ID must be 2 to 64 letters, numbers, dots, underscores, or hyphens' }, 400);
  }
  if (!name || name.length > 120) {
    return json(request, { error: 'Student name must be between 1 and 120 characters' }, 400);
  }
  if (password.length < 12 || password.length > 128) {
    return json(request, { error: 'Password must be between 12 and 128 characters' }, 400);
  }

  // 11. Check if student ID already exists in roster
  const { data: existingRoster, error: rosterErr } = await admin
    .from('students')
    .select('id')
    .eq('student_id', studentId)
    .maybeSingle();

  if (rosterErr) {
    return json(request, { error: 'Failed to verify student roster' }, 500);
  }
  if (existingRoster) {
    return json(request, { error: 'A student with this ID already exists' }, 409);
  }

  // 12. Provision user in Supabase Auth
  const email = `${studentId.toLowerCase()}@student.com`;
  const { data, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { student_id: studentId, name, class: className, section },
    app_metadata: { provisioned_by: 'admin', provisioned_by_user: user.id, account_type: 'student' },
  });

  if (createError || !data?.user) {
    if (createError?.message?.toLowerCase().includes('already registered')) {
      return json(request, { error: 'A student with this ID already exists' }, 409);
    }
    return json(request, { error: 'Failed to provision student account' }, 400);
  }

  // 13. Finalize the application profile after GoTrue's Admin API has applied
  // app_metadata. Current GoTrue versions can insert auth.users before custom
  // app_metadata is visible to an AFTER INSERT trigger.
  const { error: finalizeError } = await admin.rpc('complete_account_provisioning', {
    account_id_param: data.user.id,
  });

  // 14. Verify student profile setup was completed by the atomic finalizer
  const { data: verifiedStudent, error: verifyStudentError } = await admin
    .from('students')
    .select('id')
    .eq('id', data.user.id)
    .maybeSingle();

  if (finalizeError || verifyStudentError || !verifiedStudent) {
    const correlationId = crypto.randomUUID();
    let rollbackSuccess = false;
    try {
      const { error: deleteErr } = await admin.auth.admin.deleteUser(data.user.id);
      if (!deleteErr) {
        rollbackSuccess = true;
      } else {
        console.error(`[ROLLBACK_FAILURE] Correlation: ${correlationId}, UserId: ${data.user.id}`);
      }
    } catch {
      console.error(`[ROLLBACK_EXCEPTION] Correlation: ${correlationId}, UserId: ${data.user.id}`);
    }

    if (!rollbackSuccess) {
      return json(request, {
        error: 'Student provisioning failed and user rollback was incomplete',
        correlationId,
      }, 500);
    }

    return json(request, { error: 'Student provisioning failed during profile setup' }, 500);
  }

  return json(request, { id: data.user.id, studentId }, 201);
}

if (typeof Deno !== 'undefined' && Deno?.serve) {
  Deno.serve(handleManageStudent);
}
