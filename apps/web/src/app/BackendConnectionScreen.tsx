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
        className="max-w-lg"
        role={checking ? "status" : "alert"}
        aria-live={checking ? "polite" : "assertive"}
      >
        <EmptyHeader>
          <EmptyMedia variant="icon">
            {checking ? <Spinner /> : <ServerOff aria-hidden="true" />}
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
