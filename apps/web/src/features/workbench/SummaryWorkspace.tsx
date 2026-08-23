import { FileText, Layers3, MessageSquareText } from "lucide-react";

import { PageHeader } from "@/components/PageHeader";
import {
  Card,
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
import { format_duration, format_time } from "@/shared/format";
import type { MediaAsset, MediaSegment, Transcript } from "@/shared/types";

type SummaryWorkspaceProps = {
  selected_asset: MediaAsset | null;
  segments: MediaSegment[];
  transcript: Transcript | null;
};

export function SummaryWorkspace({
  selected_asset,
  segments,
  transcript,
}: SummaryWorkspaceProps) {
  return (
    <section
      className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 md:px-8 md:py-10"
      aria-labelledby="summary_page_title"
    >
      <PageHeader
        title_id="summary_page_title"
        eyebrow="分析总结"
        title="汇总视频分析结果"
        description="查看当前视频的转写、重点片段与结构化内容总结。"
        icon={FileText}
      />
      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <FileText aria-hidden="true" />
              当前素材
            </CardTitle>
            <CardDescription>当前工作区所选择的视频</CardDescription>
          </CardHeader>
          <CardContent>
            {selected_asset ? (
              <div className="flex min-w-0 flex-col gap-2">
                <strong className="truncate text-sm font-medium">
                  {selected_asset.title}
                </strong>
                <span className="text-xs text-muted-foreground">
                  {selected_asset.author_name ?? "未知作者"} ·{" "}
                  {format_duration(selected_asset.duration_seconds)}
                </span>
              </div>
            ) : (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <FileText aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>尚未选择素材</EmptyTitle>
                  <EmptyDescription>
                    请先在视频分析页面选择已完成下载的视频。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            )}
          </CardContent>
        </Card>
        <div className="grid grid-cols-2 gap-4">
          <SummaryMetricCard
            icon={MessageSquareText}
            title="转写内容"
            value={transcript?.segments.length ?? 0}
            description="个带时间戳的片段"
          />
          <SummaryMetricCard
            icon={Layers3}
            title="重点片段"
            value={segments.length}
            description="个可回跳的重点"
          />
        </div>
        <Card className="md:col-span-2">
          <CardHeader>
            <CardTitle>时间轴笔记</CardTitle>
            <CardDescription>
              按时间顺序查看分析生成的结构化内容。
            </CardDescription>
          </CardHeader>
          <CardContent>
            {segments.length === 0 ? (
              <Empty className="border">
                <EmptyHeader>
                  <EmptyMedia variant="icon">
                    <Layers3 aria-hidden="true" />
                  </EmptyMedia>
                  <EmptyTitle>暂无分析笔记</EmptyTitle>
                  <EmptyDescription>
                    完成全片或标记分析后，这里将显示可回跳的结构化笔记。
                  </EmptyDescription>
                </EmptyHeader>
              </Empty>
            ) : (
              <ol className="flex flex-col gap-2">
                {segments.map((segment) => (
                  <li
                    className="grid gap-2 rounded-lg border bg-muted/20 p-3 sm:grid-cols-[7rem_11rem_minmax(0,1fr)] sm:gap-3"
                    key={segment.segment_id}
                  >
                    <time className="font-mono text-xs text-primary">
                      {format_time(segment.start_seconds)} –{" "}
                      {format_time(segment.end_seconds)}
                    </time>
                    <strong className="text-sm font-medium">
                      {segment.title}
                    </strong>
                    <p className="text-sm leading-relaxed text-muted-foreground">
                      {segment.detailed_summary ??
                        segment.transcript_text ??
                        "该事件暂无文字说明。"}
                    </p>
                  </li>
                ))}
              </ol>
            )}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}

function SummaryMetricCard({
  icon: Icon,
  title,
  value,
  description,
}: {
  icon: typeof Layers3;
  title: string;
  value: number;
  description: string;
}) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Icon aria-hidden="true" />
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-1">
        <strong className="text-3xl font-semibold tracking-tight">
          {value}
        </strong>
        <span className="text-xs text-muted-foreground">{description}</span>
      </CardContent>
    </Card>
  );
}
