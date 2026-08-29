import { type DragEvent, useRef, useState } from "react";
import { CheckCircle2, CircleAlert, FileUp, Upload } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

const SUPPORTED_VIDEO_FILE_EXTENSIONS = new Set([
  ".avi",
  ".m4v",
  ".mkv",
  ".mov",
  ".mp4",
  ".webm",
]);

export type VideoImportState =
  | { stage: "idle" }
  | { stage: "importing"; filename: string }
  | { stage: "complete"; title: string }
  | { stage: "failed"; message: string };

type VideoImportCardProps = {
  state: VideoImportState;
  on_video_drop: (file: File) => void;
  on_invalid_drop: (message: string) => void;
};

export function VideoImportCard({
  state,
  on_video_drop,
  on_invalid_drop,
}: VideoImportCardProps) {
  const [is_drag_active, set_is_drag_active] = useState(false);
  const drag_depth = useRef(0);
  const is_importing = state.stage === "importing";
  const presentation = import_presentation(state, is_drag_active);

  function handle_drag_enter(event: DragEvent<HTMLDivElement>) {
    if (!has_file_payload(event) || is_importing) return;
    event.preventDefault();
    drag_depth.current += 1;
    set_is_drag_active(true);
  }

  function handle_drag_over(event: DragEvent<HTMLDivElement>) {
    if (!has_file_payload(event) || is_importing) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  }

  function handle_drag_leave(event: DragEvent<HTMLDivElement>) {
    if (!has_file_payload(event)) return;
    event.preventDefault();
    drag_depth.current = Math.max(0, drag_depth.current - 1);
    if (drag_depth.current === 0) set_is_drag_active(false);
  }

  function handle_drop(event: DragEvent<HTMLDivElement>) {
    if (!has_file_payload(event)) return;
    event.preventDefault();
    drag_depth.current = 0;
    set_is_drag_active(false);
    if (is_importing) return;

    const files = Array.from(event.dataTransfer.files);
    if (files.length !== 1) {
      on_invalid_drop("每次只能拖入一个视频文件");
      return;
    }
    const file = files[0];
    if (!is_supported_video(file)) {
      on_invalid_drop("仅支持 AVI、M4V、MKV、MOV、MP4 和 WebM 视频文件");
      return;
    }
    on_video_drop(file);
  }

  return (
    <Card>
      <CardHeader className="border-b">
        <div className="flex items-center gap-3">
          <div className="flex size-9 items-center justify-center rounded-lg bg-primary-muted text-primary">
            <FileUp aria-hidden="true" />
          </div>
          <div>
            <CardTitle role="heading" aria-level={2}>
              导入本地视频
            </CardTitle>
            <CardDescription>
              从电脑直接拖入一个视频，将其加入当前资料库。
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant="outline">
            <Upload data-icon="inline-start" />
            仅支持拖拽
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent>
        <Empty
          className={cn(
            "min-h-40 border bg-surface-subtle transition-[background-color,box-shadow]",
            is_drag_active && "bg-primary-subtle ring-2 ring-focus-ring",
          )}
          role="region"
          aria-label="本地视频拖拽导入区"
          aria-busy={is_importing}
          onDragEnter={handle_drag_enter}
          onDragOver={handle_drag_over}
          onDragLeave={handle_drag_leave}
          onDrop={handle_drop}
        >
          <EmptyHeader aria-live="polite">
            <EmptyMedia
              variant="icon"
              className={cn(state.stage === "failed" && "text-destructive")}
            >
              {presentation.icon}
            </EmptyMedia>
            <EmptyTitle>{presentation.title}</EmptyTitle>
            <EmptyDescription>{presentation.description}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </CardContent>
    </Card>
  );
}

function import_presentation(state: VideoImportState, is_drag_active: boolean) {
  if (is_drag_active) {
    return {
      icon: <Upload aria-hidden="true" />,
      title: "松开即可导入视频",
      description: "视频会复制到当前资料库，不会修改原文件。",
    };
  }
  if (state.stage === "importing") {
    return {
      icon: <Spinner />,
      title: `正在导入“${state.filename}”`,
      description: "请保持页面打开，较大的视频可能需要一些时间。",
    };
  }
  if (state.stage === "complete") {
    return {
      icon: <CheckCircle2 aria-hidden="true" />,
      title: `“${state.title}”已导入`,
      description: "视频已加入资料库，可继续拖入另一个视频。",
    };
  }
  if (state.stage === "failed") {
    return {
      icon: <CircleAlert aria-hidden="true" />,
      title: "无法导入此视频",
      description: state.message,
    };
  }
  return {
    icon: <Upload aria-hidden="true" />,
    title: "将视频拖到这里",
    description: "支持 AVI、M4V、MKV、MOV、MP4 和 WebM；不提供文件选择入口。",
  };
}

function has_file_payload(event: DragEvent<HTMLDivElement>): boolean {
  return Array.from(event.dataTransfer.types).includes("Files");
}

function is_supported_video(file: File): boolean {
  const extension_index = file.name.lastIndexOf(".");
  const extension =
    extension_index >= 0 ? file.name.slice(extension_index).toLowerCase() : "";
  return SUPPORTED_VIDEO_FILE_EXTENSIONS.has(extension);
}
