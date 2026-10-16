import { LoadingStatus, SkeletonBar } from "@/components/app/Skeleton";

// Shown while the Study tab or an exam opens. Without it the course-level
// skeleton (a chat layout) would flash in between.
export default function StudyLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LoadingStatus label="Opening Study…" />
      <div className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line px-3 sm:px-[18px]">
        <SkeletonBar className="h-3.5 w-44" />
        <SkeletonBar className="ml-auto h-3.5 w-40" />
      </div>
      <div className="mx-auto flex w-full max-w-[640px] flex-col gap-4 px-5 pt-9 sm:px-8">
        <SkeletonBar className="h-5 w-56 max-w-full" />
        <SkeletonBar className="h-3 w-full" />
        <SkeletonBar className="h-3 w-4/5" />
        <SkeletonBar className="mt-4 h-24 w-full rounded-[9px]" />
        <SkeletonBar className="h-24 w-full rounded-[9px]" />
      </div>
    </div>
  );
}
