// Photos in the browser: shrink a picked, pasted or dropped image to a JPEG,
// upload it to the student's own storage folder, and get viewing links for
// photos already saved. Used by the tutor, the exam coach, and Add materials.

import { createBrowserSupabaseClient } from "@/lib/supabase/browser";

const BUCKET = "polya_documents";
const JPEG_QUALITY = 0.86;
/** Viewing links for saved photos last an hour; the page refreshes them on reload. */
const VIEW_LINK_SECONDS = 3600;

const IMAGE_NAME_RE = /\.(jpe?g|png|webp|gif|heic|heif|avif|bmp)$/i;

/** True for anything the browser might be able to open as a picture. */
export function isImageFile(file: File): boolean {
  return file.type.startsWith("image/") || IMAGE_NAME_RE.test(file.name);
}

export class PhotoError extends Error {}

/**
 * Re-encode any image the browser can open as a JPEG whose long edge is at
 * most `maxEdge`, on a white background (for transparent screenshots). Photo
 * orientation is applied by the browser when it decodes the image.
 */
export async function shrinkToJpeg(file: File, maxEdge: number): Promise<Blob> {
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = url;
    try {
      await image.decode();
    } catch {
      throw new PhotoError(`“${file.name}” couldn't be opened. Try a JPG or PNG.`);
    }
    const longEdge = Math.max(image.naturalWidth, image.naturalHeight);
    if (!longEdge) throw new PhotoError(`“${file.name}” couldn't be opened. Try a JPG or PNG.`);
    const scale = Math.min(1, maxEdge / longEdge);
    const width = Math.max(1, Math.round(image.naturalWidth * scale));
    const height = Math.max(1, Math.round(image.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new PhotoError("Your browser couldn't prepare that photo.");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/jpeg", JPEG_QUALITY));
    if (!blob) throw new PhotoError("Your browser couldn't prepare that photo.");
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** The signed-in student's id, or a PhotoError asking them to sign in. */
export async function currentUserId(): Promise<string> {
  const supabase = createBrowserSupabaseClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) throw new PhotoError("Please sign in again to add photos.");
  return user.id;
}

/** Upload a prepared JPEG under the student's folder; returns its storage path. Throws the storage error as-is. */
export async function uploadJpeg(blob: Blob, path: string): Promise<string> {
  const supabase = createBrowserSupabaseClient();
  const { error } = await supabase.storage.from(BUCKET).upload(path, blob, { contentType: "image/jpeg" });
  if (error) throw error;
  return path;
}

/** Where a chat photo lives: `<uid>/chat/<uuid>.jpg` (the edge functions accept only this shape). */
export function chatPhotoPath(userId: string): string {
  return `${userId}/chat/${crypto.randomUUID()}.jpg`;
}

/** Viewing links for saved photos, keyed by path. Paths that fail are left out. */
export async function photoLinks(paths: readonly string[]): Promise<Record<string, string>> {
  if (paths.length === 0) return {};
  const supabase = createBrowserSupabaseClient();
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrls([...paths], VIEW_LINK_SECONDS);
  if (error || !data) return {};
  const out: Record<string, string> = {};
  for (const row of data) {
    if (row.path && row.signedUrl && !row.error) out[row.path] = row.signedUrl;
  }
  return out;
}
