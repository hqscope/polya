"use client";

import { useState } from "react";

import { storageFullCopy, type StorageFull } from "@/lib/storage-full";

// Shown in place of the generic error when an import or upload is refused
// because the student's Lectra storage is full. Polya can't sell storage, so
// the action only explains where to get more.
export default function StorageFullNotice({ state }: { state: StorageFull }) {
  const [showHow, setShowHow] = useState(false);
  const copy = storageFullCopy(state.usage);

  return (
    <div
      role="alert"
      className="m-0 flex flex-col gap-1.5 rounded-lg bg-amber-soft px-3 py-2.5 text-[12.5px] text-amber"
    >
      <span className="font-semibold">{copy.title}</span>
      <p className="m-0 leading-[1.6]">{copy.body}</p>
      <button
        type="button"
        onClick={() => setShowHow((open) => !open)}
        aria-expanded={showHow}
        className="self-start cursor-pointer text-[12px] font-semibold underline"
      >
        {copy.action}
      </button>
      {showHow ? <p className="m-0 text-[12px]">{copy.hint}</p> : null}
    </div>
  );
}
