// Photos a student attaches to a tutor or exam-coach message. The browser
// shrinks each photo to a JPEG and uploads it to the student's own
// `<uid>/chat/` folder; the request carries only those paths. The edge
// function checks every path, signs a short-lived link to each photo, and
// hands Claude the links, so no image bytes pass through the function.
// Pure module: no runtime globals.

/** Photos need a real account: an anonymous session gets this instead. */
export const PHOTOS_NEED_ACCOUNT_MESSAGE = "Sign in to add photos.";

/** Most photos one message can carry (current photos plus earlier ones re-shown). */
export const CHAT_IMAGES_MAX = 4;
/** The browser shrinks a chat photo so its long edge is at most this (Claude's own working size). */
export const CHAT_IMAGE_MAX_EDGE = 1568;
/** A full-size chat photo is about 1,600 input tokens (width × height / 750). */
export const CHAT_IMAGE_TOKENS = 1_600;
/** The AI budget meters 3 characters per token (ai-budget.ts), so a photo counts as this many characters. */
export const CHAT_IMAGE_INPUT_CHARS = CHAT_IMAGE_TOKENS * 3;
/** How long the link Claude fetches a photo from stays valid. */
export const CHAT_IMAGE_LINK_SECONDS = 600;
/**
 * Earlier photos are shown again only while the conversation is still on them:
 * when the photo message is among this many most recent stored rows (two
 * exchanges). Past that, a text turn no longer pays for old photos.
 */
export const EARLIER_PHOTO_ROWS = 4;

const CHAT_IMAGE_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.jpg$/;

/** A chat photo lives at `<uid>/chat/<uuid>.jpg`. */
export function isChatImagePath(userId: string, path: unknown): path is string {
  if (typeof path !== "string") return false;
  const prefix = `${userId}/chat/`;
  return path.startsWith(prefix) && CHAT_IMAGE_NAME_RE.test(path.slice(prefix.length));
}

export type ChatImagesCheck = { ok: true; paths: string[] } | { ok: false; reason: "invalid" | "too_many" };

/** The request's `images` field: absent, or a list of the student's own chat photo paths. */
export function parseChatImages(userId: string, raw: unknown): ChatImagesCheck {
  if (raw === undefined || raw === null) return { ok: true, paths: [] };
  if (!Array.isArray(raw)) return { ok: false, reason: "invalid" };
  const paths = [...new Set(raw)];
  if (paths.length > CHAT_IMAGES_MAX) return { ok: false, reason: "too_many" };
  if (!paths.every((path) => isChatImagePath(userId, path))) return { ok: false, reason: "invalid" };
  return { ok: true, paths: paths as string[] };
}

/** The photo paths saved on a stored user message (`meta.images`), or none. */
export function imagesFromMeta(meta: unknown): string[] {
  if (typeof meta !== "object" || meta === null || Array.isArray(meta)) return [];
  const images = (meta as { images?: unknown }).images;
  return Array.isArray(images) ? images.filter((path): path is string => typeof path === "string") : [];
}

/**
 * Photos from the student's most recent earlier message that had any, so a
 * follow-up ("what about part b?") can still see them. Rows are newest first;
 * only the last EARLIER_PHOTO_ROWS are searched, only the student's own paths
 * are kept, and at most `room` come back.
 */
export function earlierImages(
  userId: string,
  rows: readonly { role: string; meta?: unknown }[],
  room: number,
): string[] {
  if (room <= 0) return [];
  for (const row of rows.slice(0, EARLIER_PHOTO_ROWS)) {
    if (row.role !== "user") continue;
    const paths = imagesFromMeta(row.meta).filter((path) => isChatImagePath(userId, path));
    if (paths.length > 0) return paths.slice(0, room);
  }
  return [];
}

/** How a stored user message reads in the model's history when it carried photos. */
export function historyText(content: string, meta: unknown): string {
  const count = imagesFromMeta(meta).length;
  if (count === 0) return content;
  const note = `[sent ${count === 1 ? "a photo" : `${count} photos`}]`;
  return content.trim() ? `${content} ${note}` : note;
}

/** The student's message as the model reads it this turn, with a note about the photos above it. */
export function messageWithPhotos(message: string, current: number, earlier: number): string {
  if (current === 0 && earlier === 0) return message;
  const lines = [message.trim() || "(No text, just the photo.)"];
  if (current > 0) {
    lines.push(`[The student attached ${current === 1 ? "a photo" : `${current} photos`} to this message, shown above.]`);
  }
  if (earlier > 0) {
    lines.push(
      `[${earlier === 1 ? "The photo" : `The ${earlier} photos`} marked "earlier" ${earlier === 1 ? "is" : "are"} from the student's previous message, for reference.]`,
    );
  }
  return lines.join("\n\n");
}

export type ImageBlock = { type: "image"; source: { type: "url"; url: string } };
export type TextBlock = { type: "text"; text: string };

/** Content blocks for the photos, current ones first, then the earlier ones behind a label. */
export function photoBlocks(currentUrls: readonly string[], earlierUrls: readonly string[]): (ImageBlock | TextBlock)[] {
  const image = (url: string): ImageBlock => ({ type: "image", source: { type: "url", url } });
  const blocks: (ImageBlock | TextBlock)[] = currentUrls.map(image);
  if (earlierUrls.length > 0) {
    blocks.push({ type: "text", text: "Earlier:" }, ...earlierUrls.map(image));
  }
  return blocks;
}

/** A conversation title for a message that's only a photo. */
export function photoTitle(message: string, transcript: string): string {
  const fromText = message.trim() || transcript.split("\n").find((line) => line.trim())?.trim() || "";
  return (fromText || "Photo question").slice(0, 60);
}

/** The text a search runs on: what the student typed, plus what their photo says. */
export function searchText(message: string, transcript: string, max = 1_500): string {
  return [message.trim(), transcript.trim()].filter(Boolean).join("\n").slice(0, max);
}
