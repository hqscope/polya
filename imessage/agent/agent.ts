// Polya on iMessage. Direct Anthropic access (ANTHROPIC_API_KEY), not the AI Gateway.
// defaultTools: false removes eve's optional shell, file, web and delegation tools; the agent
// only has the authored tools in agent/tools/.
import { defineAgent } from "eve";
import { anthropic } from "eve/models/anthropic";

export default defineAgent({
  model: anthropic("claude-sonnet-5-5"),
  defaultTools: false,
});
