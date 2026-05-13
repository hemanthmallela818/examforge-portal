
INSERT INTO storage.buckets (id, name, public) VALUES ('question-images', 'question-images', true) ON CONFLICT (id) DO NOTHING;

CREATE POLICY "Public read question-images" ON storage.objects FOR SELECT USING (bucket_id = 'question-images');
CREATE POLICY "Principals upload question-images" ON storage.objects FOR INSERT TO authenticated WITH CHECK (bucket_id = 'question-images' AND public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Principals update question-images" ON storage.objects FOR UPDATE TO authenticated USING (bucket_id = 'question-images' AND public.has_role(auth.uid(), 'PRINCIPAL'));
CREATE POLICY "Principals delete question-images" ON storage.objects FOR DELETE TO authenticated USING (bucket_id = 'question-images' AND public.has_role(auth.uid(), 'PRINCIPAL'));
