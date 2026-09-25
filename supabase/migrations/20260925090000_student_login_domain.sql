-- Move student sign-in identities from <id>@student.com (a real, third-party
-- domain) to the reserved, non-routable <id>@students.examforge.invalid, so
-- recovery or change-email mail can never reach an outside mailbox.
--
-- Students sign in with their student ID; the app maps it to this address
-- (src/components/AuthPortal.jsx) and the manage-student Edge Function creates
-- new students with it. Only accounts whose profile role is 'student' change.
-- This migration intentionally fails (instead of skipping) if the auth schema
-- cannot be updated, because a partial change would lock students out.

BEGIN;

UPDATE auth.users AS u
SET email = lower(split_part(u.email, '@', 1)) || '@students.examforge.invalid',
    updated_at = now()
FROM public.profiles AS p
WHERE p.id = u.id
  AND p.role = 'student'
  AND lower(u.email) LIKE '%@student.com';

UPDATE auth.identities AS i
SET identity_data = jsonb_set(
      i.identity_data,
      '{email}',
      to_jsonb(lower(split_part(i.identity_data->>'email', '@', 1)) || '@students.examforge.invalid')
    ),
    updated_at = now()
FROM public.profiles AS p
WHERE p.id = i.user_id
  AND p.role = 'student'
  AND i.provider = 'email'
  AND lower(i.identity_data->>'email') LIKE '%@student.com';

COMMIT;
