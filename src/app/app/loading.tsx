import { LoadingStatus, SkeletonBar } from "@/components/app/Skeleton";

// Shown while any /app page loads (course list, connect, a first course visit).
export default function AppLoading() {
  return (
    <div className="h-full overflow-hidden">
      <LoadingStatus label="Loading…" />
      <div className="mx-auto flex max-w-[860px] flex-col gap-[22px] px-5 pt-9 pb-12 sm:px-9">
        <div className="flex flex-col gap-2.5 border-b border-line pb-[18px]">
          <SkeletonBar className="h-5 w-40" />
          <SkeletonBar className="h-3 w-56" />
        </div>
        <div className="grid gap-3.5 sm:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="flex min-h-[120px] flex-col gap-3 rounded-[10px] border border-line-soft p-5"
            >
              <SkeletonBar className="h-4 w-3/4" />
              <SkeletonBar className="h-3 w-1/2" />
              <SkeletonBar className="mt-auto h-3 w-1/3" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
