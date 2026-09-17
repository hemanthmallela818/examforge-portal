# B‑3 Migration Runbook — Close Pre‑Exam Question Pre‑Disclosure

**Migrations:** `supabase/migrations/20260911000000_stage20_close_question_predisclosure.sql`, followed by `supabase/migrations/20260912094948_stage20_definer_and_grant_hardening.sql`
**Blocker:** B‑3 (High) — an authenticated, *assigned* student can read a PENDING exam's full `questions_data` directly via PostgREST before the exam starts.
**Status:** Authored and reviewed here. **Not applied** — apply to **staging first**, run this checklist, and only then promote to production.

> This migration could not be executed or verified in the authoring environment (no database/CLI access). Every command below is written for **you** to run against your own Supabase projects. Treat the "Expected" lines as the acceptance criteria.

---

## 1. What the migration changes

Three coordinated changes, all inside one transaction (with a rollback block at the foot of the file):

1. **Column‑level SELECT grant.** Replaces the table‑wide `GRANT SELECT ON public.cbt_exams_raw TO authenticated` with `GRANT SELECT (id, title, status, class, section, created_at)` — i.e. everything **except** `questions_data`.
2. **`public.exam_questions_for_viewer(uuid)`** — a `SECURITY DEFINER` manifest function that returns the right `questions_data` for the caller (Admin‑AAL2 → reconstructed paper; assigned non‑archived student → `questions_data` minus the `questions` key; otherwise `NULL`). It re‑checks the same predicate as the `cbt_exams_read_assigned` RLS policy.
3. **`public.cbt_exams` view redefinition** — sources `questions_data` from the function instead of referencing `r.questions_data` directly. Same 7 columns/order/types, so the `INSTEAD OF` admin‑write trigger stays attached.

Why the function is required: `cbt_exams` is a `security_invoker` view, so once the column grant is removed a student selecting the view can no longer read `r.questions_data` as themselves (they'd get *permission denied for column questions_data*). Routing that column through a `SECURITY DEFINER` function preserves the student dashboard without handing students column access to the answer‑bearing base data.

Why Realtime still works: a column‑level grant still satisfies `has_table_privilege(...,'SELECT')`, so the subscriber keeps receiving row changes; Realtime then drops columns the subscriber lacks column privilege on, so `questions_data` is simply omitted from the change payload. The two client Realtime handlers (`StudentDashboard.jsx` reads `payload.new.class`/`section`; `PreExam.jsx` reads `payload.new.status`) never read `questions_data` off the payload, so both are unaffected.

---

## 2. Prerequisites

- Supabase CLI installed and authenticated (`supabase --version`).
- A **staging** Supabase project that is a faithful copy of prod's schema (all migrations through `20260910320000` applied).
- Ability to obtain a **student JWT** and an **admin (AAL2) JWT** on staging (sign in through the app and copy the `access_token` from the session, or use the auth REST endpoint).
- The staging project's **ref**, **anon key**, and REST base URL `https://<PROJECT_REF>.supabase.co/rest/v1`.
- `psql` and `curl` available locally.

Set these once in your shell for the commands below:

```bash
export SB_URL="https://<STAGING_PROJECT_REF>.supabase.co"
export SB_ANON="<STAGING_ANON_KEY>"
export STUDENT_JWT="<student access_token>"
export ADMIN_JWT="<admin AAL2 access_token>"
export EXAM_ID="<uuid of a PENDING exam assigned to that student's class/section>"
```

---

## 3. Apply to staging

Preferred (Supabase CLI, applies all pending migrations in order):

```bash
supabase link --project-ref <STAGING_PROJECT_REF>
supabase db push
```

Or apply just this file with `psql` against the staging connection string:

```bash
psql "<STAGING_DB_CONNECTION_STRING>" \
  -f supabase/migrations/20260911000000_stage20_close_question_predisclosure.sql

psql "$STAGING_DB_URL" -v ON_ERROR_STOP=1 \
  -f supabase/migrations/20260912094948_stage20_definer_and_grant_hardening.sql
```

**Expected:** applies cleanly (single `BEGIN … COMMIT`); no error. A `NOTICE` from the `REVOKE … FROM anon` is harmless (anon never held the grant).

### 3.1 Structural verification (psql)

```sql
-- (a) authenticated must NOT have column SELECT on questions_data,
--     but MUST have it on the safe columns.
SELECT has_column_privilege('authenticated','public.cbt_exams_raw','questions_data','SELECT') AS qdata,  -- expect f
       has_column_privilege('authenticated','public.cbt_exams_raw','status','SELECT')        AS status,  -- expect t
       has_column_privilege('authenticated','public.cbt_exams_raw','class','SELECT')         AS class;   -- expect t

-- (b) the manifest function exists, is SECURITY DEFINER, and search_path is pinned.
SELECT proname, prosecdef, proconfig
FROM pg_proc
WHERE proname IN ('exam_questions_for_viewer', 'reconstruct_exam_questions');
-- expect prosecdef = t and proconfig contains search_path="" for both

-- (c) the view still has exactly 7 columns, questions_data last, and is security_invoker.
\d+ public.cbt_exams

-- (d) the INSTEAD OF admin-write trigger is still attached to the view.
SELECT tgname FROM pg_trigger
WHERE tgrelid = 'public.cbt_exams'::regclass AND NOT tgisinternal;  -- expect the cbt_exams modification trigger
```

---

## 4. Security proof (the B‑3 negative test — must now fail)

The exact pre‑disclosure request the fix closes:

```bash
curl -s "$SB_URL/rest/v1/cbt_exams_raw?select=questions_data&id=eq.$EXAM_ID" \
  -H "apikey: $SB_ANON" \
  -H "Authorization: Bearer $STUDENT_JWT"
```

**Before fix:** returned `[{"questions_data":{...,"questions":{...full paper...}}}]`.
**After fix (Expected):** the `questions_data` column is not selectable for `authenticated` → PostgREST returns a `42501`‑class permission error (e.g. `"permission denied for ... cbt_exams_raw"` / column error) **or** an empty/needs‑column result. The full `questions` payload **must not** appear. ✅

Belt‑and‑suspenders — try to widen the selection; each must fail or omit `questions_data`:

```bash
# Whole row
curl -s "$SB_URL/rest/v1/cbt_exams_raw?select=*&id=eq.$EXAM_ID" \
  -H "apikey: $SB_ANON" -H "Authorization: Bearer $STUDENT_JWT"

# Direct RPC to the manifest (should return metadata only — never the questions array)
curl -s "$SB_URL/rest/v1/rpc/exam_questions_for_viewer" \
  -H "apikey: $SB_ANON" -H "Authorization: Bearer $STUDENT_JWT" \
  -H "Content-Type: application/json" \
  -d "{\"p_exam_id\":\"$EXAM_ID\"}"
```

**Expected:** the `select=*` call errors or returns the row **without** `questions_data`; the RPC returns metadata with **no `questions` key** (and `null` for an exam the student isn't assigned to). ✅

---

## 5. Regression checks (must all still pass)

Metadata is still readable by the student through the safe view:

```bash
curl -s "$SB_URL/rest/v1/cbt_exams?select=id,title,status,class,section,created_at,questions_data&id=eq.$EXAM_ID" \
  -H "apikey: $SB_ANON" -H "Authorization: Bearer $STUDENT_JWT"
```

**Expected:** returns the row; `questions_data` present **without** a `questions` key (subjects/marks/duration metadata only). ✅

Then, in the app against staging:

1. **Student dashboard** lists the assigned exam(s); the 15s poll and Realtime both refresh on status change. *(Flip the exam PENDING→ACTIVE as admin and watch it update.)*
2. **Pre‑exam screen** shows the live status and enables **Start** when the exam goes ACTIVE (Realtime `status` payload still delivered).
3. **`start_exam_session`** still delivers the server‑randomised paper on a legitimate start (this remains the only path to the questions).
4. **Admin (AAL2)** can create/edit an exam and sees reconstructed questions in the editor:
   ```bash
   curl -s "$SB_URL/rest/v1/cbt_exams?select=*&id=eq.$EXAM_ID" \
     -H "apikey: $SB_ANON" -H "Authorization: Bearer $ADMIN_JWT"
   ```
   **Expected:** `questions_data.questions` present **with** `correctAnswer` re‑injected. ✅
5. **`node --test tests/*.test.mjs`** and any DB/integration tests still green.

---

## 6. Rollback (only if staging validation fails)

Uncomment and run the `ROLLBACK` block at the bottom of the migration file (restores the previous view definition, restores the table‑wide grant, drops the manifest function), or run it directly:

```bash
psql "<STAGING_DB_CONNECTION_STRING>" <<'SQL'
BEGIN;
  CREATE OR REPLACE VIEW public.cbt_exams WITH (security_invoker = true) AS
  SELECT r.id, r.title, r.status, r.class, r.section, r.created_at,
    CASE
      WHEN public.is_admin_aal2()
        THEN public.reconstruct_exam_questions(r.questions_data, a.answers)
      ELSE r.questions_data - 'questions'
    END AS questions_data
  FROM public.cbt_exams_raw r
  LEFT JOIN public.cbt_exam_answers a ON r.id = a.exam_id;

  REVOKE SELECT (id, title, status, class, section, created_at)
    ON public.cbt_exams_raw FROM authenticated;
  GRANT SELECT ON public.cbt_exams_raw TO authenticated;

  DROP FUNCTION IF EXISTS public.exam_questions_for_viewer(uuid);
COMMIT;
SQL
```

**Expected:** returns the schema to its pre‑B‑3‑fix state. Then re‑investigate before re‑applying.

---

## 7. Promotion to production

Only after **every** Expected above is met on staging:

```bash
supabase link --project-ref <PROD_PROJECT_REF>
supabase db push
```

Immediately re‑run the §4 negative test against prod with a real assigned‑student JWT to confirm the hole is closed in production, and spot‑check §5.1–5.3 (dashboard, pre‑exam status, exam start).

---

## 8. Sign‑off record

| Check | Env | Result | Notes |
|---|---|---|---|
| 3.1 structural verification | staging | ☐ | |
| 4 pre‑disclosure denied | staging | ☐ | |
| 5.1 dashboard lists exams | staging | ☐ | |
| 5.2 pre‑exam Realtime status | staging | ☐ | |
| 5.3 start_exam_session delivers paper | staging | ☐ | |
| 5.4 admin AAL2 edit + reconstructed | staging | ☐ | |
| 5.5 node --test green | staging | ☐ | |
| 4 pre‑disclosure denied | prod | ☐ | |
| 5.1–5.3 smoke | prod | ☐ | |
