# Summarises a claude-code-action execution file for an issue comment: how the run ended, the
# agent's last message, and every tool call the permission rules refused.
# Run with `jq -rs`; the file is one JSON array (or, in older versions, one message per line).
(if (.[0] | type) == "array" then .[0] else . end) as $msgs
| ([$msgs[] | select(.type == "result")] | last // {}) as $r
| "\nEnded: `\($r.subtype // "unknown")` after \($r.num_turns // "?") turns.\n"
  + (if ($r.result // "") != "" then
       "\nThe agent's last message:\n\n" + ($r.result | .[0:3000] | split("\n") | map("> " + .) | join("\n")) + "\n"
     else "" end)
  + (if (($r.permission_denials // []) | length) > 0 then
       "\nRefused by the permission rules:\n\n```\n"
       + ([$r.permission_denials[] | "\(.tool_name): \(.tool_input.command // (.tool_input | tostring))" | .[0:300]] | join("\n"))
       + "\n```\n"
     else "" end)
