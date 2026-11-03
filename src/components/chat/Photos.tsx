"use client";

import { useCallback, useEffect, useRef, useState, type ClipboardEvent, type ReactNode } from "react";

import {
  CHAT_IMAGE_MAX_EDGE,
  CHAT_IMAGES_MAX,
} from "../../../supabase/functions/_shared/chat-images.ts";
import {
  chatPhotoPath,
  currentUserId,
  isImageFile,
  photoLinks,
  PhotoError,
  shrinkToJpeg,
  uploadJpeg,
} from "@/lib/photos";
import { detectStorageFull } from "@/lib/storage-full-client";

/** A photo on a message: its saved path, and a link to show it (a local preview or a viewing link). */
export interface ChatPhoto {
  path: string;
  url?: string;
}

interface PendingPhoto {
  id: string;
  preview: string | null;
  path: string | null;
}

const TOO_MANY = `You can add up to ${CHAT_IMAGES_MAX} photos to a message.`;

async function uploadFailure(err: unknown): Promise<string> {
  if (err instanceof PhotoError) return err.message;
  if (await detectStorageFull(err)) return "Your storage is full, so that photo couldn't be added.";
  return "That photo couldn't be added. Please try again.";
}

/** The photos waiting in a message box: added by picking, pasting or dropping, then sent with the message. */
export function useChatPhotos() {
  const [items, setItems] = useState<PendingPhoto[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const count = useRef(0);

  useEffect(() => {
    count.current = items.length;
  }, [items]);

  // Previews of photos still in the box are released when the box goes away.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  useEffect(
    () => () => {
      for (const item of itemsRef.current) if (item.preview) URL.revokeObjectURL(item.preview);
    },
    [],
  );

  const add = useCallback(async (files: File[]) => {
    const images = files.filter(isImageFile);
    if (images.length === 0) {
      if (files.length > 0) setNotice("Only photos can be added to a message.");
      return;
    }
    const room = CHAT_IMAGES_MAX - count.current;
    if (room <= 0) {
      setNotice(TOO_MANY);
      return;
    }
    setNotice(images.length > room ? TOO_MANY : null);
    const picked = images.slice(0, room);
    count.current += picked.length;

    let userId: string;
    try {
      userId = await currentUserId();
    } catch (err) {
      count.current -= picked.length;
      setNotice(await uploadFailure(err));
      return;
    }

    await Promise.all(
      picked.map(async (file) => {
        const id = crypto.randomUUID();
        setItems((prev) => [...prev, { id, preview: null, path: null }]);
        try {
          const blob = await shrinkToJpeg(file, CHAT_IMAGE_MAX_EDGE);
          const preview = URL.createObjectURL(blob);
          setItems((prev) => prev.map((item) => (item.id === id ? { ...item, preview } : item)));
          const path = await uploadJpeg(blob, chatPhotoPath(userId));
          setItems((prev) => prev.map((item) => (item.id === id ? { ...item, path } : item)));
        } catch (err) {
          setItems((prev) => {
            const gone = prev.find((item) => item.id === id);
            if (gone?.preview) URL.revokeObjectURL(gone.preview);
            return prev.filter((item) => item.id !== id);
          });
          setNotice(await uploadFailure(err));
        }
      }),
    );
  }, []);

  const remove = useCallback((id: string) => {
    setItems((prev) => {
      const gone = prev.find((item) => item.id === id);
      if (gone?.preview) URL.revokeObjectURL(gone.preview);
      return prev.filter((item) => item.id !== id);
    });
    setNotice(null);
  }, []);

  /** Take sent photos out of the box. Their previews live on in the message, so they aren't released. */
  const release = useCallback((photos: readonly ChatPhoto[]) => {
    if (photos.length === 0) return;
    const paths = new Set(photos.map((photo) => photo.path));
    setItems((prev) => prev.filter((item) => !item.path || !paths.has(item.path)));
    setNotice(null);
  }, []);

  /** Put a message's photos back in the box after it didn't get an answer. */
  const restore = useCallback((photos: readonly ChatPhoto[]) => {
    if (photos.length === 0) return;
    setItems((prev) => {
      const have = new Set(prev.map((item) => item.path));
      const back = photos
        .filter((photo) => !have.has(photo.path))
        .map((photo) => ({ id: crypto.randomUUID(), preview: photo.url ?? null, path: photo.path }));
      return [...prev, ...back].slice(0, CHAT_IMAGES_MAX);
    });
  }, []);

  const ready: ChatPhoto[] = items
    .filter((item): item is PendingPhoto & { path: string } => item.path !== null)
    .map((item) => ({ path: item.path, url: item.preview ?? undefined }));

  return {
    items,
    ready,
    uploading: items.some((item) => item.path === null),
    notice,
    clearNotice: () => setNotice(null),
    add,
    remove,
    release,
    restore,
  };
}

export type ChatPhotos = ReturnType<typeof useChatPhotos>;

/** Image files from a paste (a screenshot, a copied picture), or none. */
export function pastedPhotos(event: ClipboardEvent): File[] {
  return Array.from(event.clipboardData?.files ?? []).filter(isImageFile);
}

/** The photos waiting to be sent, above the message box. */
export function PhotoTray({ photos }: { photos: ChatPhotos }) {
  if (photos.items.length === 0 && !photos.notice) return null;
  return (
    <div className="flex flex-col gap-1.5">
      {photos.items.length > 0 ? (
        <ul className="m-0 flex list-none flex-wrap gap-2 p-0" aria-label="Photos to send">
          {photos.items.map((item, i) => (
            <li key={item.id} className="relative h-14 w-14 shrink-0">
              {item.preview ? (
                // eslint-disable-next-line @next/next/no-img-element -- a local preview, not a page asset
                <img
                  src={item.preview}
                  alt={`Photo ${i + 1}`}
                  className={`h-14 w-14 rounded-md border border-line object-cover ${item.path ? "" : "opacity-50"}`}
                />
              ) : (
                <span className="block h-14 w-14 animate-pulse rounded-md border border-line bg-line-soft" />
              )}
              {item.path ? null : (
                <span className="sr-only" role="status">
                  Adding photo {i + 1}…
                </span>
              )}
              <button
                type="button"
                onClick={() => photos.remove(item.id)}
                aria-label={`Remove photo ${i + 1}`}
                className="absolute -top-1.5 -right-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border border-line bg-surface text-[11px] leading-none text-ink2 shadow-card hover:text-ink"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {photos.notice ? (
        <p role="status" className="m-0 px-0.5 text-[11.5px] text-amber">
          {photos.notice}
        </p>
      ) : null}
    </div>
  );
}

/** Opens the photo picker (the camera too, on a phone). */
export function AddPhotoButton({ photos, disabled }: { photos: ChatPhotos; disabled?: boolean }) {
  return (
    <label
      title="Add a photo of a problem, your work, or a slide"
      className={`flex h-[26px] shrink-0 items-center gap-1 rounded-md border border-line px-2 text-[12px] font-semibold text-ink2 focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-accent ${
        disabled ? "cursor-default opacity-40" : "cursor-pointer hover:border-accent hover:bg-accent-soft hover:text-accent-ink"
      }`}
    >
      <svg aria-hidden="true" viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="1.75" y="3.75" width="12.5" height="9.5" rx="1.5" />
        <circle cx="8" cy="8.5" r="2.25" />
        <path d="M5.5 3.75l1-1.5h3l1 1.5" />
      </svg>
      Photo
      <input
        type="file"
        accept="image/*"
        multiple
        disabled={disabled}
        aria-label="Add a photo"
        className="sr-only"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          event.target.value = "";
          void photos.add(files);
        }}
      />
    </label>
  );
}

/** Lets photos be dropped anywhere on the conversation, with a hint while one is dragged over it. */
export function PhotoDropZone({
  onFiles,
  disabled,
  className = "",
  children,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const carriesFiles = (types: readonly string[] | DOMStringList | undefined) =>
    Array.from((types ?? []) as ArrayLike<string>).includes("Files");

  return (
    <div
      className={`relative ${className}`}
      onDragEnter={(event) => {
        if (disabled || !carriesFiles(event.dataTransfer?.types)) return;
        event.preventDefault();
        depth.current += 1;
        setOver(true);
      }}
      onDragOver={(event) => {
        if (disabled || !carriesFiles(event.dataTransfer?.types)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!carriesFiles(event.dataTransfer?.types)) return;
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setOver(false);
      }}
      onDrop={(event) => {
        if (!carriesFiles(event.dataTransfer?.types)) return;
        event.preventDefault();
        depth.current = 0;
        setOver(false);
        if (!disabled) onFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {children}
      {over ? (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-xl border-2 border-dashed border-accent bg-surface/90 text-[13.5px] font-semibold text-accent-ink">
          Drop photos to add them to your message
        </div>
      ) : null}
    </div>
  );
}

/** The photos on a sent message. Saved photos get fresh viewing links when the page loads. */
export function MessagePhotos({ photos }: { photos: readonly ChatPhoto[] }) {
  // null until this message's saved photos have links (or turned out to be gone).
  const [links, setLinks] = useState<Record<string, string> | null>(null);
  const missingKey = photos
    .filter((photo) => !photo.url)
    .map((photo) => photo.path)
    .join("\n");

  useEffect(() => {
    if (!missingKey) return;
    let cancelled = false;
    void photoLinks(missingKey.split("\n")).then((found) => {
      if (!cancelled) setLinks(found);
    });
    return () => {
      cancelled = true;
    };
  }, [missingKey]);

  if (photos.length === 0) return null;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {photos.map((photo, i) => {
        const url = photo.url ?? links?.[photo.path];
        if (!url && links) return null;
        return url ? (
          <a key={photo.path} href={url} target="_blank" rel="noreferrer" className="block">
            {/* eslint-disable-next-line @next/next/no-img-element -- short-lived private links can't go through image optimization */}
            <img
              src={url}
              alt={photos.length === 1 ? "Your photo" : `Your photo ${i + 1}`}
              className="h-28 max-w-[200px] rounded-lg border border-line object-cover"
            />
          </a>
        ) : (
          <span key={photo.path} className="block h-28 w-24 animate-pulse rounded-lg border border-line bg-line-soft" />
        );
      })}
    </div>
  );
}
