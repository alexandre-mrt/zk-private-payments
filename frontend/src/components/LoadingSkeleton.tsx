export function LoadingSkeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="animate-pulse space-y-3">
      {Array.from({ length: lines }).map((_, i) => (
        <div
          key={i}
          className="h-4 bg-zinc-800 rounded"
          style={{ width: `${80 - i * 15}%` }}
        />
      ))}
    </div>
  );
}

export function CardSkeleton() {
  return (
    <div className="bg-zinc-900 border border-zinc-800 rounded-lg p-6 animate-pulse">
      <div className="h-6 bg-zinc-800 rounded w-1/3 mb-4" />
      <div className="space-y-3">
        <div className="h-4 bg-zinc-800 rounded w-full" />
        <div className="h-4 bg-zinc-800 rounded w-2/3" />
        <div className="h-10 bg-zinc-800 rounded w-full mt-4" />
      </div>
    </div>
  );
}
