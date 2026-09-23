-- Reviews are fetched by their primary-key result_id. The additional
-- exam/student index is not used by any exposed or maintenance path.
DROP INDEX IF EXISTS public.student_result_reviews_exam_student_idx;
