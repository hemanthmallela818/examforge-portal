-- Stage 26: close the final legacy-data validation gap.
--
-- These checks were originally introduced as NOT VALID so existing deployments
-- could adopt write-time protection before cleaning historical rows. All cleanup
-- migrations now precede this file, so production readiness requires PostgreSQL
-- to verify every pre-existing row as well.

BEGIN;

ALTER TABLE public.profiles
  VALIDATE CONSTRAINT profiles_role_valid;

ALTER TABLE public.cbt_exams_raw
  VALIDATE CONSTRAINT cbt_exams_status_valid;

ALTER TABLE public.classes
  VALIDATE CONSTRAINT classes_data_valid;

ALTER TABLE public.question_bank
  VALIDATE CONSTRAINT question_bank_data_valid;

ALTER TABLE public.cbt_exams_raw
  VALIDATE CONSTRAINT cbt_exams_data_valid;

COMMIT;
