-- Photos: students can add photos of notes, handouts or slides as course
-- materials, and attach photos to tutor and exam-coach messages.
--
-- 1. A course material can now be a photo (source_kind 'image'). Widens the
--    existing check; every current row still passes.
-- 2. The polya_documents bucket accepts JPEGs. The browser re-encodes every
--    photo as a JPEG before upload, so no other image type is needed. Only a
--    bucket that already has an allowlist is touched: a bucket with none (the
--    local stack) already accepts everything, and giving it a one-item list
--    would start refusing PDFs.

alter table public.polya_sources drop constraint polya_sources_source_kind_check;
alter table public.polya_sources add constraint polya_sources_source_kind_check check (source_kind in (
  'pdf', 'html', 'transcript_txt', 'transcript_json', 'transcript_vtt', 'transcript_srt', 'image'
));

update storage.buckets
set allowed_mime_types = allowed_mime_types || array['image/jpeg']
where id = 'polya_documents'
  and allowed_mime_types is not null
  and not ('image/jpeg' = any(allowed_mime_types));
