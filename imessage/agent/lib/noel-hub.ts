// Noel's personal MCP hub (mcp.noelsason.com), available only in conversations with Noel's own
// linked Polya account. Read-only by allowlist: a write tool added to the hub later never shows up
// here until it's added below on purpose. The hub still asks for confirmation before anything that
// sends, publishes, or changes data, but none of those tools are exposed.

/** Every read-only tool the hub listed in hub_capabilities on 2026-10-20. */
export const HUB_READ_TOOLS = [
  "hub_connections", "hub_capabilities", "hub_activity", "hub_search",
  "linkedin_auth_status", "linkedin_list_drafts", "linkedin_preview_post", "linkedin_get_posts", "linkedin_list_scheduled_posts",
  "gmail_search", "gmail_read", "gmail_list_labels", "gmail_list_filters", "gmail_get_attachment",
  "calendar_list_calendars", "calendar_list_events", "calendar_free_busy", "calendar_get_settings",
  "drive_search", "drive_read_file", "drive_list_folder", "drive_get_file", "drive_list_shared_drives", "drive_download_file",
  "drive_list_revisions", "drive_list_comments", "drive_list_permissions",
  "docs_read_structure", "sheets_read", "sheets_get_metadata", "sheets_batch_read", "slides_read", "forms_get", "forms_responses",
  "contacts_search", "tasks_list", "chromewebstore_status",
  "spotify_now_playing", "spotify_history", "spotify_search",
  "slack_search", "slack_list_conversations", "slack_read_conversation",
  "vercel_projects", "vercel_deployments", "vercel_deployment_logs", "vercel_runtime_logs", "vercel_domains",
  "canvas_courses", "canvas_upcoming", "canvas_assignments", "canvas_assignment", "canvas_announcements", "canvas_modules",
  "canvas_pages", "canvas_files", "canvas_syllabus", "canvas_discussions", "canvas_submission", "canvas_calendar", "canvas_course_search",
  "academic_feedback", "academic_exam_readiness",
  "homelab_status",
  "github_recent_activity", "github_search", "github_read", "github_ci_status", "github_workflow_logs", "github_repo_stats",
  "scope_blog_posts", "scope_documents", "scope_document_read", "scope_course_search", "scope_metrics",
  "scope_product_overview", "scope_activation_funnel", "scope_retention", "scope_feature_usage", "scope_errors", "scope_feedback", "scope_release_impact",
  "literature_search", "literature_recent", "literature_get_paper", "literature_related", "literature_bibliography",
  "research_fulltext", "research_paper_compare", "research_result_compare",
  "career_opportunities", "career_followups", "career_contacts",
  "workflow_runs", "monitor_list", "monitor_test",
  "supabase_projects", "supabase_schema", "supabase_query", "supabase_advisors", "supabase_logs", "supabase_functions",
  "appstore_apps", "appstore_builds", "appstore_versions", "appstore_reviews",
  "hpc_clusters", "hpc_status", "hpc_jobs", "hpc_job", "hpc_logs", "hpc_files",
] as const;

export type HubReadTool = (typeof HUB_READ_TOOLS)[number];

/**
 * The only tools the personal digest (hub-digest.ts) calls from code. A subset of the read
 * allowlist, checked by the compiler here and again at call time (noel-hub-client.ts).
 */
export const DIGEST_HUB_TOOLS = [
  "hub_connections",
  "gmail_search",
  "canvas_announcements",
  "calendar_list_events",
] as const satisfies readonly HubReadTool[];

export type DigestHubTool = (typeof DIGEST_HUB_TOOLS)[number];

export interface HubConfig {
  url: string;
  token: string;
  ownerId: string;
}

/** The hub connection for this student, or null unless it's the configured owner and the hub is set up. */
export function hubFor(studentId: string | undefined, env: Readonly<Record<string, string | undefined>> = process.env): HubConfig | null {
  const ownerId = env.NOEL_HUB_POLYA_USER_ID?.trim();
  const token = env.NOEL_HUB_TOKEN?.trim();
  if (!ownerId || !token || token.length < 32 || !studentId || studentId !== ownerId) return null;
  const url = (env.NOEL_HUB_URL?.trim() || "https://mcp.noelsason.com/mcp").replace(/\/+$/, "");
  return url.startsWith("https://") ? { url, token, ownerId } : null;
}

/** The hub as its owner would get it in a turn, or null until it's fully configured. For the digest loop. */
export function hubOwner(env: Readonly<Record<string, string | undefined>> = process.env): HubConfig | null {
  return hubFor(env.NOEL_HUB_POLYA_USER_ID?.trim(), env);
}
