-- ============================================================================
-- Polya — course websites as a source. A course whose materials live on a
-- public class site (e.g. ds100.org/fa26) instead of Canvas is crawled into:
--   site_page   a page of the site (or same-host notes it links), html
--   site_file   a PDF the site hosts, pdf
--   drive_file  a Google Drive / Slides / Docs file the site links, pdf
-- Content units, chunking and retrieval are unchanged, so only the origin
-- CHECK widens. polya_courses.site_url remembers the address for
-- "Check for updates".
--
-- Additive; polya_ objects only; applied remotely via MCP apply_migration.
-- ============================================================================

alter table public.polya_sources drop constraint if exists polya_sources_origin_check;

alter table public.polya_sources
  add constraint polya_sources_origin_check check (origin in (
    'canvas_file', 'canvas_page', 'canvas_syllabus', 'canvas_assignment',
    'canvas_module_item', 'upload_transcript', 'canvas_media',
    'site_page', 'site_file', 'drive_file'
  ));

alter table public.polya_courses
  add column if not exists site_url text
    check (site_url is null or (site_url like 'https://%' and char_length(site_url) <= 2048));

comment on column public.polya_courses.site_url is
  'Public course website imported into this course (normalized https URL), or null.';
