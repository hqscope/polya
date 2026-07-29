-- ============================================================================
-- Polya — allow a new source origin `canvas_media` for lecture videos pulled
-- from the course's Kaltura media gallery. Their transcripts reuse the existing
-- transcript_* source_kinds and the transcript_segment unit_type, so only the
-- origin CHECK widens; polya_content_units is untouched.
--
-- Additive; polya_ objects only; applied remotely via MCP apply_migration.
-- ============================================================================

alter table public.polya_sources drop constraint if exists polya_sources_origin_check;

alter table public.polya_sources
  add constraint polya_sources_origin_check check (origin in (
    'canvas_file', 'canvas_page', 'canvas_syllabus', 'canvas_assignment',
    'canvas_module_item', 'upload_transcript', 'canvas_media'
  ));
