import { LoadingStatus, SkeletonBar } from "@/components/app/Skeleton";

// Shown while a course's materials page loads.
export default function MaterialsLoading() {
  return (
    <div className="h-full overflow-hidden">
      <LoadingStatus label="Loading course materials…" />
      <div className="mx-auto flex max-w-[640px] flex-col gap-7 px-5 pt-9 pb-14 sm:px-8">
        <div className="flex flex-col gap-2.5 border-b border-line pb-[18px]">
          <SkeletonBar className="h-3 w-24" />
          <SkeletonBar className="h-5 w-64 max-w-full" />
          <SkeletonBar className="h-3 w-48" />
        </div>
        <SkeletonBar className="h-24 w-full rounded-[9px]" />
        <div className="flex flex-col gap-2.5 border-t border-line pt-6">
          <SkeletonBar className="h-3 w-40" />
          <div className="flex flex-col gap-3 rounded-[9px] border border-line-soft bg-rail px-3.5 py-3">
            {[0, 1, 2, 3, 4].map((i) => (
              <SkeletonBar key={i} className="h-3.5 w-full" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
