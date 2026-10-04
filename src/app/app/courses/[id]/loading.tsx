import { LoadingStatus, SkeletonBar } from "@/components/app/Skeleton";

// Shown while a course opens or you switch between courses.
export default function CourseLoading() {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <LoadingStatus label="Opening your course…" />
      <div className="flex h-[46px] shrink-0 items-center gap-2.5 border-b border-line px-3 sm:px-[18px]">
        <SkeletonBar className="h-3.5 w-44" />
        <SkeletonBar className="ml-auto h-7 w-24 rounded-md" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col items-center px-4 pt-16 sm:px-7">
            <SkeletonBar className="h-3 w-28" />
            <SkeletonBar className="mt-4 h-5 w-60 max-w-full" />
            <SkeletonBar className="mt-3 h-3 w-72 max-w-full" />
            <SkeletonBar className="mt-2 h-3 w-64 max-w-full" />
          </div>
          <div className="shrink-0 px-2 pt-2 pb-2 sm:px-7 sm:pb-[18px]">
            <div className="mx-auto h-[76px] max-w-[660px] rounded-[10px] border border-line bg-surface shadow-card" />
          </div>
        </div>
        <div className="hidden w-[320px] shrink-0 flex-col gap-2.5 border-l border-line bg-rail px-3.5 pt-3.5 lg:flex">
          <SkeletonBar className="h-3 w-16" />
          <SkeletonBar className="h-16 w-full rounded-lg" />
          <SkeletonBar className="h-16 w-full rounded-lg" />
        </div>
      </div>
    </div>
  );
}
