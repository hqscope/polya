-- ============================================================================
-- Polya — student-uploaded PDFs.
--
-- Students can now add their own PDFs (textbook chapters, notes, practice
-- exams printed from another site) next to what comes from Canvas. They upload
-- straight to the polya_documents bucket under their own prefix, exactly like
-- transcripts, and polya-import `add_upload` registers the file as a source
-- with the new origin 'upload_file'. Nothing else about sources changes:
-- source_kind 'pdf' and every content_role already exist.
--
-- Additive-only; polya_ objects only. Passed a local `supabase db reset`;
-- applied 2026-10-16 via MCP apply_migration.
-- ============================================================================

alter table public.polya_sources drop constraint if exists polya_sources_origin_check;

alter table public.polya_sources
  add constraint polya_sources_origin_check check (origin in (
    'canvas_file', 'canvas_page', 'canvas_syllabus', 'canvas_assignment',
    'canvas_module_item', 'upload_transcript', 'canvas_media',
    'site_page', 'site_file', 'drive_file', 'upload_file'
  ));
