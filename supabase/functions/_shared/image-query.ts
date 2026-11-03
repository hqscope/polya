// Reads the photos on a tutor or coach message into a short piece of text, so
// the course search can find the lecture, homework or notes the photo is
// about. The answering model still sees the photos themselves; this text only
// steers retrieval. Best effort: any failure returns "" and the turn searches
// on the typed message alone.

import { CHAT_IMAGE_INPUT_CHARS } from "./chat-images.ts";

const denoEnv = (globalThis as { Deno?: { env: { get(key: string): string | undefined } } }).Deno?.env;
const ANTHROPIC_KEY = denoEnv?.get("ANTHROPIC_API_KEY") ?? "";

export const PHOTO_SEARCH_MODEL = "claude-haiku-5-5";
export const PHOTO_SEARCH_MAX_TOKENS = 700;
const PHOTO_SEARCH_TIMEOUT_MS = 15_000;

const PROMPT =
  "These are photos a student took of their coursework. Transcribe the question, problem or text " +
  "they show as plain text, in under 150 words, so it can be used to search the student's course " +
  "notes. Keep the key terms, symbols and numbers. Output only the text.";

/** Input characters the budget should charge for reading `count` photos. */
export function photoSearchInputChars(count: number): number {
  return count * CHAT_IMAGE_INPUT_CHARS + PROMPT.length;
}

export async function transcribePhotosForSearch(urls: readonly string[]): Promise<string> {
  if (urls.length === 0 || !ANTHROPIC_KEY) return "";
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PHOTO_SEARCH_TIMEOUT_MS);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: abort.signal,
      headers: {
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: PHOTO_SEARCH_MODEL,
        max_tokens: PHOTO_SEARCH_MAX_TOKENS,
        output_config: { effort: "low" },
        messages: [
          {
            role: "user",
            content: [
              ...urls.map((url) => ({ type: "image", source: { type: "url", url } })),
              { type: "text", text: PROMPT },
            ],
          },
        ],
      }),
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      console.warn("[photo-search] transcription failed:", response.status, detail.slice(0, 200));
      return "";
    }
    const data = (await response.json()) as { stop_reason?: string; content?: Array<{ type: string; text?: string }> };
    if (data.stop_reason === "refusal") return "";
    return (data.content ?? [])
      .filter((block) => block.type === "text")
      .map((block) => block.text ?? "")
      .join("")
      .trim()
      .slice(0, 1_500);
  } catch (error) {
    console.warn("[photo-search] transcription failed:", error);
    return "";
  } finally {
    clearTimeout(timer);
  }
}
