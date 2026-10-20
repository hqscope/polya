import assert from "node:assert/strict";
import { test } from "node:test";

import { HUB_READ_TOOLS, hubFor } from "../agent/lib/noel-hub.ts";

const OWNER = "2311615d-72eb-4ac8-8371-0488f6787aca";
const env = { NOEL_HUB_POLYA_USER_ID: OWNER, NOEL_HUB_TOKEN: "t".repeat(40) };

test("the hub is only for the owner's own account", () => {
  assert.ok(hubFor(OWNER, env));
  assert.equal(hubFor("11111111-1111-1111-1111-111111111111", env), null);
  assert.equal(hubFor(undefined, env), null);
});

test("the hub stays off until it's fully configured", () => {
  assert.equal(hubFor(OWNER, {}), null);
  assert.equal(hubFor(OWNER, { ...env, NOEL_HUB_TOKEN: "short" }), null);
  assert.equal(hubFor(OWNER, { ...env, NOEL_HUB_URL: "http://insecure.example/mcp" }), null);
  assert.equal(hubFor(OWNER, env)?.url, "https://mcp.noelsason.com/mcp");
});

test("no write tools are allowlisted", () => {
  // The hub's tools that send, publish, change, or delete something (from its tool list).
  const writes = [
    "gmail_send", "gmail_create_draft", "gmail_modify_messages", "gmail_trash_messages", "gmail_untrash_messages",
    "gmail_manage_label", "gmail_manage_filter", "calendar_create_event", "calendar_update_event", "calendar_delete_event",
    "calendar_respond_to_event", "calendar_batch", "drive_create_folder", "drive_manage_file", "drive_share", "drive_upload_file",
    "drive_comment", "docs_create", "docs_append", "docs_apply", "sheets_write", "sheets_batch_write", "sheets_create", "sheets_apply",
    "slides_create", "slides_apply", "forms_create", "forms_apply", "contacts_manage", "tasks_create", "tasks_update", "tasks_delete",
    "tasks_batch", "tasks_manage_list", "slack_send_message", "github_comment", "github_create_issue", "github_merge_pull_request",
    "github_commit_files", "vercel_deploy", "vercel_promote", "vercel_env", "scope_blog_publish", "linkedin_create_post",
    "linkedin_update_post", "linkedin_delete_post", "linkedin_repost", "linkedin_schedule_post", "linkedin_create_draft",
    "spotify_control", "hpc_submit", "hpc_cancel", "monitor_create", "monitor_update", "monitor_delete", "workflow_start",
    "workflow_update", "hub_connect_service", "hub_disconnect_service", "hub_passkeys",
  ];
  assert.deepEqual(HUB_READ_TOOLS.filter((t) => writes.includes(t)), []);
});
