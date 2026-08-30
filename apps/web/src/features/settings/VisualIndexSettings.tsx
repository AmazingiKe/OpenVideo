import { HardDriveDownload, RotateCw, Unplug } from "lucide-react";
import { useEffect, useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import {
  get_visual_index_status,
  prepare_visual_index,
  unload_visual_index,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import type { VisualIndexStatus } from "@/shared/types";

const VISUAL_STATUS_POLL_MS = 1_000;
const ACTIVE_VISUAL_STATES = new Set(["downloading", "loading", "indexing"]);

export function VisualIndexSettings() {
  const [status, set_status] = useState<VisualIndexStatus | null>(null);
  const [pending, set_pending] = useState(false);
  const [error, set_error] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    void get_visual_index_status(controller.signal)
      .then(set_status)
      .catch((request_error: unknown) => {
        if (!is_abort_error(request_error))
          set_error(error_message(request_error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!status || !ACTIVE_VISUAL_STATES.has(status.state)) return;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      void get_visual_index_status(controller.signal)
        .then(set_status)
        .catch((request_error: unknown) => {
          if (!is_abort_error(request_error))
            set_error(error_message(request_error));
        });
    }, VISUAL_STATUS_POLL_MS);
    return () => {
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [status]);

  async function prepare() {
    set_pending(true);
    set_error(null);
    try {
      set_status(await prepare_visual_index());
    } catch (request_error) {
      set_error(error_message(request_error));
    } finally {
      set_pending(false);
    }
  }

  async function unload() {
    set_pending(true);
    set_error(null);
    try {
      set_status(await unload_visual_index());
    } catch (request_error) {
      set_error(error_message(request_error));
    } finally {
      set_pending(false);
    }
  }

  if (!status) {
    return (
      <p
        className="flex items-center gap-2 text-sm text-muted-foreground"
        role="status"
      >
        <Spinner /> 正在读取视觉索引状态
      </p>
    );
  }
  return (
    <VisualIndexSettingsPanel
      status={status}
      pending={pending}
      error={error}
      on_prepare={() => void prepare()}
      on_unload={() => void unload()}
    />
  );
}

type VisualIndexSettingsPanelProps = {
  status: VisualIndexStatus;
  pending: boolean;
  error: string | null;
  on_prepare: () => void;
  on_unload: () => void;
};

export function VisualIndexSettingsPanel({
  status,
  pending,
  error,
  on_prepare,
  on_unload,
}: VisualIndexSettingsPanelProps) {
  const active = ACTIVE_VISUAL_STATES.has(status.state);
  const ready = status.state === "ready";
  return (
    <div className="grid gap-4">
      <div className="flex flex-col gap-4 rounded-lg border p-4 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-medium">推荐视觉检索</p>
            <Badge variant={ready ? "secondary" : "outline"}>
              {visual_state_label(status)}
            </Badge>
          </div>
          <p className="text-sm text-muted-foreground">{status.message}</p>
          <p className="text-xs text-muted-foreground">
            SigLIP2 仅在需要时下载和加载，应用启动与素材导入不会等待它。
          </p>
        </div>
        {ready && status.model_loaded ? (
          <Button
            type="button"
            variant="outline"
            onClick={on_unload}
            disabled={pending}
          >
            {pending ? <Spinner /> : <Unplug data-icon="inline-start" />}
            释放模型
          </Button>
        ) : (
          <Button
            type="button"
            onClick={on_prepare}
            disabled={pending || active}
          >
            {pending || active ? (
              <Spinner />
            ) : ready ? (
              <RotateCw data-icon="inline-start" />
            ) : (
              <HardDriveDownload data-icon="inline-start" />
            )}
            {ready ? "按需加载" : "准备推荐索引"}
          </Button>
        )}
      </div>
      {active ? (
        <Progress
          value={status.progress_percent}
          aria-label={`视觉索引进度 ${Math.round(status.progress_percent)}%`}
        />
      ) : null}
      {error || status.error_message ? (
        <Alert variant="destructive">
          <AlertTitle>视觉索引暂不可用</AlertTitle>
          <AlertDescription>{error ?? status.error_message}</AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function visual_state_label(status: VisualIndexStatus): string {
  if (status.state === "ready")
    return status.model_loaded ? "已加载" : "已建立 · 未加载";
  return {
    not_prepared: "未准备",
    downloading: "下载中",
    loading: "加载中",
    indexing: "索引中",
    error: "可重试",
  }[status.state];
}
