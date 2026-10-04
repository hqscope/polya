// Placeholder shapes for route loading states. Decorative: each loading screen
// carries one screen-reader status line instead.
export function SkeletonBar({ className = "" }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={`block rounded bg-line-soft motion-safe:animate-pulse ${className}`}
    />
  );
}

export function LoadingStatus({ label }: { label: string }) {
  return (
    <p role="status" className="sr-only">
      {label}
    </p>
  );
}
