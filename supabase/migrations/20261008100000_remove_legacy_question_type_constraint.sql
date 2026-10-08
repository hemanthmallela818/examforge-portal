BEGIN;

SET LOCAL lock_timeout = '5s';

-- Legacy hosted schemas retained this separate type check. The validated
-- question_bank_data_valid constraint now enforces all supported types.
ALTER TABLE public.question_bank
  DROP CONSTRAINT IF EXISTS question_bank_type_check;

COMMIT;
