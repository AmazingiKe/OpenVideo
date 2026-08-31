import { ServerOff } from "lucide-react";

import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";

export type BackendConnectionState = "checking" | "disconnected";

export function BackendConnectionScreen({
  state,
}: {
  state: BackendConnectionState;
}) {
  const checking = state === "checking";
  return (
    <main className="grid min-h-svh place-items-center bg-background px-4 py-8 text-foreground">
      <Empty
        key={state}
        className="max-w-lg motion-safe:animate-in motion-safe:duration-300 motion-safe:fade-in-0 motion-safe:zoom-in-95"
        role={checking ? "status" : "alert"}
        aria-live={checking ? "polite" : "assertive"}
      >
        <EmptyHeader>
          <EmptyMedia className="relative" variant="icon">
            {checking ? (
              <Spinner className="motion-reduce:animate-none" />
            ) : (
              <>
                <span
                  aria-hidden="true"
                  className="absolute inset-0 rounded-lg ring-1 ring-current motion-safe:animate-ping"
                />
                <ServerOff
                  aria-hidden="true"
                  className="motion-safe:animate-pulse"
                />
              </>
            )}
          </EmptyMedia>
          <EmptyTitle role="heading" aria-level={1}>
            {checking ? "正在连接后端" : "后端未启动"}
          </EmptyTitle>
          <EmptyDescription>
            {checking
              ? "正在确认 OpenVideo 后端是否可以响应。"
              : "OpenVideo 无法连接到后端。请尝试启动完整程序，或单独启动后端服务；连接恢复后会自动继续，每 3 秒重试一次。"}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    </main>
  );
}
