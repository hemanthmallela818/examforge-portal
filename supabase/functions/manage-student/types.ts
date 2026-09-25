// Minimal structural views of the two Supabase clients. Only the calls this
// function makes are described, so tests can inject small fakes and the real
// clients are narrowed once, at the boundary in clients.ts.

import type { Json } from './http.ts';
import type { Logger } from './log.ts';

export interface DbError {
  code?: string;
  message?: string;
}

export interface QueryResult<T> {
  data: T | null;
  error: DbError | null;
}

export type RpcArgs = Record<string, unknown>;
export type Rpc = <T = unknown>(fn: string, args?: RpcArgs) => PromiseLike<QueryResult<T>>;

export interface FilterBuilder {
  eq(column: string, value: string): FilterBuilder;
  maybeSingle<T = Record<string, unknown>>(): PromiseLike<QueryResult<T>>;
}

export interface TableClient {
  select(columns: string): FilterBuilder;
  insert(row: Record<string, unknown>): PromiseLike<{ error: DbError | null }>;
}

export interface AuthUser {
  id: string;
}

export interface CreateUserAttributes {
  email: string;
  password: string;
  email_confirm: boolean;
  user_metadata: Record<string, unknown>;
  app_metadata: Record<string, unknown>;
}

export interface CallerClient {
  auth: {
    getUser(): PromiseLike<{ data: { user: AuthUser | null }; error: unknown }>;
  };
  rpc: Rpc;
}

export interface AdminClient {
  from(table: string): TableClient;
  rpc: Rpc;
  auth: {
    admin: {
      createUser(attributes: CreateUserAttributes): PromiseLike<{
        data: { user: AuthUser | null } | null;
        error: { message?: string } | null;
      }>;
      deleteUser(id: string): PromiseLike<{ error: unknown }>;
      updateUserById(id: string, attributes: { password: string }): PromiseLike<{ error: unknown }>;
    };
  };
}

export type ManageStudentClients = { caller: CallerClient; admin: AdminClient };

/** The parsed JSON request body. It is untrusted until an action validates it. */
export type RequestBody = unknown;

export type Validation<T> = { ok: true; value: T } | { ok: false; error: string };

/** Everything an action handler may use; built once per request by the router. */
export interface ActionContext {
  user: AuthUser;
  caller: CallerClient;
  admin: AdminClient;
  log: Logger;
  json: Json;
  safeDbMessage: (error: DbError | null | undefined, fallback: string) => string;
}

/**
 * 'admin' actions require an AAL2 managed administrator (is_admin_aal2).
 * 'root' actions skip the AAL2 check and instead require is_root_developer.
 * Both require the server-owned profile role 'admin'.
 */
export type Authority = 'admin' | 'root';

export interface ActionDefinition<Input> {
  authority: Authority;
  /**
   * Run validation before the root authority check. Only clear-scoped-data
   * historically validated its confirmation first; every other action checks
   * authority first. Kept so error precedence is unchanged.
   */
  validateBeforeAuthority?: boolean;
  /** Pure input validation; every failure is a 400 with the returned message. */
  validate(body: RequestBody): Validation<Input>;
  handle(ctx: ActionContext, input: Input): Promise<Response>;
}
