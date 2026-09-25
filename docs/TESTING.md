# Testing

## Database behaviour tests (`npm run test:db`)

`tests/db/` runs behavioural tests against the **latest** database definitions.
Each test file builds a fresh in-memory PostgreSQL (PGlite, WASM) database. It
installs a few Supabase stubs, then applies **every** file in
`supabase/migrations/` in filename order. Nothing is skipped or rewritten. If a
migration fails, the run stops with an error naming the file.

- `tests/db/harness.mjs` holds the stubs, the migration replay, identity
  helpers and seed helpers.
  - Stubs: the roles `anon`, `authenticated`, `service_role` and
    `supabase_admin`; `auth.users` and `auth.identities`; `auth.jwt()`,
    `auth.uid()` and `auth.role()`; storage buckets and objects; and the
    `supabase_realtime` publication.
  - Identity helpers: `asSuperuser()`, `asService()`, `asAnon()`, `asRoot()`,
    `asAdmin()` and `asStudent(uuid, sessionId)`. Each returns a handle bound to
    that identity. Every call on a handle sets the role and JWT claims again
    first.
  - Seed helpers: `seedAdministrators()`, `createClass()`, `createStudent()`
    and `createExam()`. Accounts are created through `auth.users`, so the real
    provisioning trigger runs. Exams are created through the `cbt_exams` view,
    as the admin UI does.
- pg_cron is not available in PGlite. The scheduler migration therefore takes
  its own documented fallback branch. The finalization tests run the exact
  command that pg_cron would schedule.
- Run with `npm run -s test:db`. The suite takes about 45 seconds, because each
  file replays the migrations once (about 6 seconds).

When you add a migration that needs another platform object (another `auth.*`
table, for example), add a documented stub to `SUPABASE_STUBS`. Do not skip or
rewrite migration SQL.
