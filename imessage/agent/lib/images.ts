// Helpers for the view_image tool. Anthropic models read JPEG, PNG, GIF and WebP, but iPhones send
// photos as HEIC, which reaches the model as a bare file name. view_image reads the staged
// attachment from the sandbox and converts HEIC/HEIF to JPEG with heic-convert (pure JS + wasm).
import convert from "heic-convert";

/** Where eve stages inbound attachments (and files that tools return) in the sandbox. */
export const ATTACHMENTS_DIR = "/workspace/.eve/attachments";

/**
 * Largest image the tool returns. eve sends a returned image's bytes to the model only up to
 * 3 MiB (and 8000 px per side); a larger one arrives as a file name, which is the bug this fixes.
 */
export const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

/** JPEG qualities to try, best first, until the converted photo fits under the cap. */
export const JPEG_QUALITIES: readonly number[] = [0.85, 0.7, 0.55, 0.4, 0.25];

/** Lists staged attachment files, newest first. A glob with no match prints nothing. */
export const LIST_ATTACHMENTS_COMMAND = `ls -1t ${ATTACHMENTS_DIR}/*/* 2>/dev/null || true`;

export type ImageKind = "heic" | "jpeg" | "png" | "gif" | "webp";

const HEIC_BRANDS = new Set(["heic", "heix", "mif1", "hevc"]);
const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
const PASS_THROUGH_TYPES: Record<Exclude<ImageKind, "heic">, string> = {
  jpeg: "image/jpeg",
  png: "image/png",
  gif: "image/gif",
  webp: "image/webp",
};
// eve's staged file names: a 16-hex-digit content hash directory, then a name made of [\w.-].
const ATTACHMENT_PATH = /\/workspace\/\.eve\/attachments\/[0-9a-f]{16}\/[\w.-]+/g;
const IMAGE_NAME = /\.(heic|heif|jpe?g|png|gif|webp)$/i;

function ascii(bytes: Uint8Array, start: number, end: number): string {
  return String.fromCharCode(...bytes.subarray(start, end));
}

/** Identifies an image by its magic bytes, or returns null for anything else. */
export function detectImageKind(bytes: Uint8Array): ImageKind | null {
  if (bytes.length >= 12 && ascii(bytes, 4, 8) === "ftyp" && HEIC_BRANDS.has(ascii(bytes, 8, 12))) return "heic";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "jpeg";
  if (bytes.length >= 8 && PNG_SIGNATURE.every((byte, i) => bytes[i] === byte)) return "png";
  const gif = ascii(bytes, 0, 6);
  if (gif === "GIF87a" || gif === "GIF89a") return "gif";
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 12) === "WEBP") return "webp";
  return null;
}

/** Encodes at each quality in turn and returns the first result at or under maxBytes, or null. */
export async function encodeUnderCap(
  encode: (quality: number) => Promise<Uint8Array>,
  maxBytes: number = MAX_IMAGE_BYTES,
  qualities: readonly number[] = JPEG_QUALITIES,
): Promise<{ bytes: Uint8Array; quality: number } | null> {
  for (const quality of qualities) {
    const bytes = await encode(quality);
    if (bytes.byteLength <= maxBytes) return { bytes, quality };
  }
  return null;
}

export type PreparedImage =
  | { ok: true; bytes: Uint8Array; mediaType: string; converted: boolean }
  | { ok: false; message: string };

/**
 * Makes an image the model can read: HEIC/HEIF becomes a JPEG under the cap; JPEG, PNG, GIF and
 * WebP pass through unchanged when they fit.
 */
export async function prepareImage(bytes: Uint8Array, maxBytes: number = MAX_IMAGE_BYTES): Promise<PreparedImage> {
  const kind = detectImageKind(bytes);
  if (kind === null) {
    return { ok: false, message: "That file isn't a JPEG, PNG, GIF, WebP, or HEIC image, so it can't be shown." };
  }
  if (kind !== "heic") {
    return bytes.byteLength <= maxBytes
      ? { ok: true, bytes, mediaType: PASS_THROUGH_TYPES[kind], converted: false }
      : { ok: false, message: `The image is ${megabytes(bytes.byteLength)}, over the ${megabytes(maxBytes)} that can be viewed.` };
  }
  let jpeg: { bytes: Uint8Array; quality: number } | null;
  try {
    jpeg = await encodeUnderCap(
      async (quality) => new Uint8Array(await convert({ buffer: bytes, format: "JPEG", quality })),
      maxBytes,
    );
  } catch (error) {
    console.error("[view_image] HEIC conversion failed:", error instanceof Error ? error.message : error);
    return { ok: false, message: "The HEIC photo couldn't be converted." };
  }
  return jpeg === null
    ? { ok: false, message: `The photo is still over ${megabytes(maxBytes)} after compressing it.` }
    : { ok: true, bytes: jpeg.bytes, mediaType: "image/jpeg", converted: true };
}

function megabytes(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Text in one message part that can name a staged file: labels, file names, and sandbox refs. */
function partStrings(part: unknown): string[] {
  if (typeof part === "string") return [part];
  if (!isRecord(part)) return [];
  const out: string[] = [];
  if (typeof part.text === "string") out.push(part.text);
  if (typeof part.filename === "string") out.push(part.filename);
  if (part.data instanceof URL && part.data.protocol === "eve-sandbox:") out.push(part.data.searchParams.get("path") ?? "");
  // Tool results carry their parts under output.value.
  if (isRecord(part.output) && Array.isArray(part.output.value)) out.push(...part.output.value.flatMap(partStrings));
  return out;
}

/** Image attachment paths named in the conversation, newest first. */
export function imagePathsInMessages(messages: readonly unknown[]): string[] {
  const paths: string[] = [];
  for (const message of messages) {
    if (!isRecord(message)) continue;
    const content = message.content;
    const parts: unknown[] = typeof content === "string" ? [content] : Array.isArray(content) ? content : [];
    for (const text of parts.flatMap(partStrings)) {
      for (const match of text.matchAll(ATTACHMENT_PATH)) {
        if (IMAGE_NAME.test(match[0])) paths.push(match[0]);
      }
    }
  }
  return [...new Set(paths.reverse())];
}

/** Image paths from LIST_ATTACHMENTS_COMMAND output, newest first. */
export function imagePathsInListing(stdout: string): string[] {
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith(`${ATTACHMENTS_DIR}/`) && IMAGE_NAME.test(line));
}

export function isAttachmentPath(path: string): boolean {
  return path.startsWith(`${ATTACHMENTS_DIR}/`) && !path.split("/").includes("..");
}

function baseName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/**
 * Chooses which staged file to open. With no request, the newest candidate. A full attachment path
 * is used as given. Anything else is treated as a file name (e.g. "IMG_8520.heic"); eve replaces
 * characters outside [\w.-] with "_" when it stages a file, so the name is matched the same way.
 */
export function pickImagePath(requested: string | undefined, newestFirst: readonly string[]): string | null {
  const wanted = requested?.trim();
  if (!wanted) return newestFirst[0] ?? null;
  if (isAttachmentPath(wanted)) return wanted;
  const name = baseName(wanted).replace(/[^\w.-]+/g, "_").toLowerCase();
  return newestFirst.find((path) => baseName(path).toLowerCase() === name) ?? null;
}

/** File name for the image the tool returns: a converted HEIC keeps its name with a .jpg ending. */
export function returnedFileName(path: string, converted: boolean): string {
  const name = baseName(path);
  return converted ? `${name.replace(/\.[^.]*$/, "")}.jpg` : name;
}
