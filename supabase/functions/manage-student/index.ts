// manage-student Edge Function: administrator and root-developer account and
// data management. The request pipeline lives in router.ts, the action table in
// actions/index.ts, and pure input validation in validation.ts.

import { createSupabaseClients } from './clients.ts';
import { routeRequest } from './router.ts';
import type { ManageStudentClients } from './types.ts';

export { isOriginAllowed } from './http.ts';
export { STUDENT_EMAIL_DOMAIN } from './constants.ts';
export type { ManageStudentClients } from './types.ts';

export async function handleManageStudent(
  request: Request,
  injectedClients?: ManageStudentClients,
): Promise<Response> {
  // Each injected client falls back independently to the real one, as before.
  return routeRequest(request, (authorization) => {
    if (injectedClients?.caller && injectedClients?.admin) {
      return { caller: injectedClients.caller, admin: injectedClients.admin };
    }
    const clients = createSupabaseClients(authorization);
    return {
      caller: injectedClients?.caller ?? clients.caller,
      admin: injectedClients?.admin ?? clients.admin,
    };
  });
}

if (typeof Deno !== 'undefined' && Deno?.serve) {
  // Only the request is forwarded: Deno's ServeHandlerInfo is not a client pair.
  Deno.serve((request: Request) => handleManageStudent(request));
}
