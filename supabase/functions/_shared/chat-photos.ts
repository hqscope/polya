// Runtime half of chat-images.ts for polya-tutor and polya-coach: turn the
// checked photo paths into short-lived links Claude can fetch, and work out
// which earlier photos to show again.

import {
  CHAT_IMAGE_LINK_SECONDS,
  CHAT_IMAGES_MAX,
  earlierImages,
  photoBlocks,
  type ImageBlock,
  type TextBlock,
} from "./chat-images.ts";
import { service, STORAGE_BUCKET } from "./service.ts";

/** Signed links for each path, in order, or null when any photo is missing. */
export async function signChatPhotos(paths: readonly string[]): Promise<string[] | null> {
  if (paths.length === 0) return [];
  const { data, error } = await service.storage.from(STORAGE_BUCKET).createSignedUrls([...paths], CHAT_IMAGE_LINK_SECONDS);
  if (error || !data) {
    console.error("[chat-photos] signing failed:", error?.message);
    return null;
  }
  const byPath = new Map(data.map((row) => [row.path, row.error ? null : row.signedUrl]));
  const urls = paths.map((path) => byPath.get(path) ?? null);
  return urls.every((url): url is string => typeof url === "string" && url.length > 0) ? urls : null;
}

export interface TurnPhotos {
  /** Links to this message's photos. */
  current: string[];
  /** Links to photos from the student's previous photo message, shown again for follow-ups. */
  earlier: string[];
  /** Content blocks to put before the turn's text. */
  blocks: (ImageBlock | TextBlock)[];
}

/**
 * This turn's photos plus, when there's room, the ones from the student's most
 * recent earlier photo message (rows newest first). Null when one of this
 * message's own photos can't be found; an earlier photo that's gone is skipped.
 * Pass `signedCurrent` when this message's photos were already signed.
 */
export async function loadTurnPhotos(
  userId: string,
  paths: readonly string[],
  historyNewestFirst: readonly { role: string; meta?: unknown }[],
  signedCurrent?: string[],
): Promise<TurnPhotos | null> {
  const current = signedCurrent ?? (await signChatPhotos(paths));
  if (!current) return null;
  const earlierPaths = earlierImages(userId, historyNewestFirst, CHAT_IMAGES_MAX - paths.length)
    .filter((path) => !paths.includes(path));
  const earlier = earlierPaths.length > 0 ? (await signChatPhotos(earlierPaths)) ?? [] : [];
  return { current, earlier, blocks: photoBlocks(current, earlier) };
}
