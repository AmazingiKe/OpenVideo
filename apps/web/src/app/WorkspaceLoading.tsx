import { Skeleton } from "@/components/ui/skeleton";

export function WorkspaceLoading() {
  return (
    <div
      className="grid h-full min-h-96 grid-cols-[minmax(11rem,18%)_1fr] gap-px bg-border max-[640px]:grid-cols-1"
      role="status"
      aria-label="正在准备工作区"
    >
      <div className="flex flex-col gap-4 bg-background p-4">
        <Skeleton className="h-8 w-3/4" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
      <div className="flex flex-col gap-6 bg-background p-6">
        <div className="flex items-center justify-between gap-4">
          <Skeleton className="h-8 w-48" />
          <Skeleton className="h-8 w-24" />
        </div>
        <Skeleton className="min-h-64 flex-1" />
      </div>
      <span className="sr-only">正在准备工作区</span>
    </div>
  );
}
