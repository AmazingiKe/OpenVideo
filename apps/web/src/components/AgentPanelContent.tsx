import { Brain, CheckCircle2, CircleX, RotateCcw, Wrench } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { format_time } from "@/shared/format";
import type { AgentArtifact, AgentEvent, AgentRun } from "@/shared/types";

const TOOL_LABELS: Record<string, string> = {
  read_markers: "读取现有标记",
  search_evidence: "检索视频证据",
  inspect_frames: "检查关键画面",
  propose_marker_changes: "生成标记变更预览",
  read_summary_document: "读取总结文档",
  propose_summary_edit: "生成总结修改预览",
  propose_summary_media: "生成图文增强预览",
  correct_transcript: "校对字幕",
};

export function AgentRunBadge({ stage }: { stage: AgentRun["stage"] }) {
  const label: Record<AgentRun["stage"], string> = {
    pending: "等待运行",
    running: "运行中",
    waiting_for_approval: "等待确认",
    complete: "已完成",
    failed: "失败",
    cancelled: "已取消",
    interrupted: "已中断",
  };
  return (
    <Badge variant={stage === "failed" ? "destructive" : "secondary"}>
      {label[stage]}
    </Badge>
  );
}

type TimelineItem =
  | {
      type: "message";
      id: string;
      role: "user" | "assistant";
      content: string;
      reasoning?: string;
    }
  | { type: "tools"; id: string; events: AgentEvent[] };

export function build_agent_timeline(events: AgentEvent[]): TimelineItem[] {
  const items: TimelineItem[] = [];
  for (const event of events) {
    if (event.event_type === "run.status" && event.payload.input) {
      items.push({
        type: "message",
        id: event.event_id,
        role: "user",
        content: String(event.payload.input),
      });
    } else if (
      event.event_type === "message.completed" &&
      (event.payload.content || event.payload.reasoning_content)
    ) {
      items.push({
        type: "message",
        id: event.event_id,
        role: "assistant",
        content: String(event.payload.content ?? ""),
        reasoning: event.payload.reasoning_content
          ? String(event.payload.reasoning_content)
          : undefined,
      });
    } else if (event.event_type === "tool.status") {
      const previous = items.at(-1);
      if (previous?.type === "tools") {
        const call_id = String(event.payload.call_id ?? event.event_id);
        const previous_index = previous.events.findIndex(
          (item) => String(item.payload.call_id ?? item.event_id) === call_id,
        );
        if (previous_index >= 0) previous.events[previous_index] = event;
        else previous.events.push(event);
      } else {
        items.push({ type: "tools", id: event.event_id, events: [event] });
      }
    }
  }
  return items;
}

export function AgentReasoning({
  content,
  running = false,
}: {
  content: string;
  running?: boolean;
}) {
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="reasoning">
        <AccordionTrigger>
          <Brain />
          {running ? "正在思考" : "思考过程"}
        </AccordionTrigger>
        <AccordionContent>
          <p className="whitespace-pre-wrap text-muted-foreground">{content}</p>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function AgentToolActivity({ events }: { events: AgentEvent[] }) {
  const failed_count = events.filter(
    (event) => event.payload.stage === "failed",
  ).length;
  const running_count = events.filter(
    (event) => event.payload.stage === "started",
  ).length;
  const first_tool_name = tool_label(events[0]);
  const activity_summary =
    events.length === 1
      ? first_tool_name
      : `${first_tool_name}等 ${events.length} 项`;
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="tool-activity">
        <AccordionTrigger className="py-2">
          <Wrench />
          <span className="min-w-0 flex-1 truncate">
            工具活动 · {activity_summary}
          </span>
          <Badge variant={failed_count > 0 ? "destructive" : "outline"}>
            {failed_count > 0
              ? `${failed_count} 项失败`
              : running_count > 0
                ? "调用中"
                : "已完成"}
          </Badge>
        </AccordionTrigger>
        <AccordionContent>
          <ul className="flex flex-col" aria-label="工具调用详情">
            {events.map((event) => (
              <AgentToolCall
                key={String(event.payload.call_id ?? event.event_id)}
                event={event}
              />
            ))}
          </ul>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function AgentToolCall({ event }: { event: AgentEvent }) {
  const failed = event.payload.stage === "failed";
  const running = event.payload.stage === "started";
  const result = event.payload.result;
  return (
    <li className="flex min-w-0 items-start gap-2 border-b py-2 last:border-b-0">
      {running ? (
        <Wrench className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      ) : failed ? (
        <CircleX className="mt-0.5 size-4 shrink-0 text-destructive" />
      ) : (
        <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium">
            {tool_label(event)}
          </span>
          <span className="shrink-0 text-xs text-muted-foreground">
            {failed ? "失败" : running ? "调用中" : "完成"}
          </span>
        </div>
        {result !== undefined ? (
          <details className="mt-1">
            <summary className="cursor-pointer text-xs text-muted-foreground">
              查看返回数据
            </summary>
            <pre className="mt-2 max-h-56 overflow-auto rounded-md bg-muted p-3 text-xs">
              {JSON.stringify(result, null, 2)}
            </pre>
          </details>
        ) : null}
      </div>
    </li>
  );
}

function tool_label(event: AgentEvent | undefined): string {
  const name = String(event?.payload.name ?? "tool");
  return TOOL_LABELS[name] ?? name;
}

export function AgentArtifactCard({
  artifact,
  on_seek,
  on_resolve,
  on_regenerate,
}: {
  artifact: AgentArtifact;
  on_seek?: (seconds: number) => void;
  on_resolve: (action: "approve" | "reject") => void;
  on_regenerate?: () => void;
}) {
  const pending = artifact.status === "pending";
  return (
    <Card aria-label="Agent 审批结果">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <CardTitle>变更预览</CardTitle>
            <CardDescription>
              {artifact_description(artifact.result_type)}
            </CardDescription>
          </div>
          <Badge
            variant={artifact.status === "stale" ? "destructive" : "outline"}
          >
            {artifact_status_label(artifact.status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <ArtifactPayload artifact={artifact} on_seek={on_seek} />
        {artifact.status === "stale" ? (
          <Alert variant="destructive">
            <RotateCcw />
            <AlertTitle>预览已过期</AlertTitle>
            <AlertDescription>
              原始数据已变化，请重新运行 Agent 生成新预览。
            </AlertDescription>
            {on_regenerate ? (
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={on_regenerate}
              >
                重新生成
              </Button>
            ) : null}
          </Alert>
        ) : null}
      </CardContent>
      {pending ? (
        <CardFooter className="flex-wrap justify-end gap-2">
          <Button variant="outline" onClick={() => on_resolve("reject")}>
            整批拒绝
          </Button>
          <Button onClick={() => on_resolve("approve")}>整批接受</Button>
        </CardFooter>
      ) : null}
    </Card>
  );
}

function ArtifactPayload({
  artifact,
  on_seek,
}: {
  artifact: AgentArtifact;
  on_seek?: (seconds: number) => void;
}) {
  const media =
    typeof artifact.payload.media === "object" &&
    artifact.payload.media !== null
      ? (artifact.payload.media as Record<string, unknown>)
      : null;
  if (artifact.result_type === "summary_media" && media) {
    const start = Number(media.start_seconds ?? Number.NaN);
    const end = Number(media.end_seconds ?? Number.NaN);
    const confidence = Number(artifact.payload.confidence ?? Number.NaN);
    return (
      <div className="flex flex-col gap-3 rounded-md border p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary">
            {media.media_type === "gif" ? "GIF" : "图片"}
          </Badge>
          <p className="text-sm font-medium">
            {String(media.caption ?? "关键画面")}
          </p>
        </div>
        <p className="text-sm text-muted-foreground">
          {String(artifact.payload.reason ?? "该画面有助于理解正文。")}
        </p>
        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <span>
            时间：{Number.isFinite(start) ? format_time(start) : "未知"}
            {Number.isFinite(end) ? `–${format_time(end)}` : ""}
          </span>
          {Number.isFinite(confidence) ? (
            <span>置信度：{Math.round(confidence * 100)}%</span>
          ) : null}
        </div>
        {Number.isFinite(start) && on_seek ? (
          <Button
            type="button"
            variant="link"
            className="w-fit px-0"
            onClick={() => on_seek(start)}
          >
            跳转检查画面
          </Button>
        ) : null}
      </div>
    );
  }
  const changes = Array.isArray(artifact.payload.changes)
    ? (artifact.payload.changes as Record<string, unknown>[])
    : [];
  if (changes.length > 0) {
    return (
      <ol className="flex flex-col gap-2">
        {changes.map((change, index) => {
          const after =
            typeof change.after === "object" && change.after !== null
              ? (change.after as Record<string, unknown>)
              : null;
          const start = Number(
            change.start_seconds ?? after?.start_seconds ?? Number.NaN,
          );
          return (
            <li
              key={`${artifact.artifact_id}-${index}`}
              className="rounded-md border p-3"
            >
              <p className="text-sm font-medium">
                {String(change.operation ?? `第 ${index + 1} 项`)}
              </p>
              {change.before !== undefined || change.after !== undefined ? (
                <pre className="mt-2 overflow-auto text-xs text-muted-foreground">
                  {JSON.stringify(
                    { before: change.before, after: change.after },
                    null,
                    2,
                  )}
                </pre>
              ) : null}
              {Number.isFinite(start) && on_seek ? (
                <Button
                  variant="link"
                  className="px-0"
                  onClick={() => on_seek(start)}
                >
                  跳转到 {format_time(start)}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  }
  if (typeof artifact.payload.diff === "string") {
    return (
      <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">
        {artifact.payload.diff}
      </pre>
    );
  }
  return (
    <details>
      <summary className="cursor-pointer text-sm text-muted-foreground">
        查看变更详情
      </summary>
      <pre className="mt-2 overflow-auto rounded-md bg-muted p-3 text-xs">
        {JSON.stringify(artifact.payload, null, 2)}
      </pre>
    </details>
  );
}

function artifact_description(result_type: string): string {
  return (
    {
      marker_changes: "标记操作将作为一个原子批次提交。",
      summary_edit: "总结正文与子文档建议将在确认后提交。",
      summary_media: "确认后会从原视频生成媒体并插入当前文档。",
      transcript_correction: "字幕文字会更新，时间边界保持不变。",
    }[result_type] ?? "确认后才会修改业务数据。"
  );
}

function artifact_status_label(status: AgentArtifact["status"]): string {
  return {
    pending: "待确认",
    approved: "已接受",
    rejected: "已拒绝",
    stale: "已过期",
  }[status];
}
