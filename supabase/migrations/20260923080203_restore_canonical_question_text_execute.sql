-- Stage 21 moved public-schema functions to an explicit allowlist after this
-- helper was originally granted to authenticated users. Question-bank writes
-- execute the helper from a validation trigger, so administrators need EXECUTE
-- while anonymous clients must remain denied.

REVOKE ALL ON FUNCTION public.canonical_question_text(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.canonical_question_text(text) TO authenticated, service_role;
