import { BookOpenText, FilePenLine, Search } from "lucide-react";

import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";

export type AgentToolTraceData = {
  call_id: string;
  name: string;
  arguments: Record<string, unknown>;
  result?: unknown;
};

const TOOL_PRESENTATION = {
  search_video_evidence: {
    label: "搜索视频证据",
    icon: Search,
  },
  read_summary_document: {
    label: "读取总结文档",
    icon: BookOpenText,
  },
  propose_summary_change: {
    label: "创建修改建议",
    icon: FilePenLine,
  },
  search_transcript: { label: "搜索转录", icon: Search },
  search_analysis: { label: "搜索分析事件", icon: Search },
  read_markers: { label: "读取标记", icon: BookOpenText },
  inspect_frames: { label: "检查画面", icon: Search },
  propose_marker_changes: { label: "创建标记建议", icon: FilePenLine },
} as const;

export function AgentToolTrace({
  trace,
}: {
  trace: AgentToolTraceData;
}) {
  const presentation =
    TOOL_PRESENTATION[trace.name as keyof typeof TOOL_PRESENTATION];
  const Icon = presentation?.icon ?? Search;
  const completed = trace.result !== undefined;

  return (
    <Accordion type="single" collapsible className="rounded-lg border px-3">
      <AccordionItem value={trace.call_id} className="border-0">
        <AccordionTrigger className="py-2 text-sm hover:no-underline">
          <span className="flex min-w-0 items-center gap-2">
            <Icon aria-hidden="true" />
            <span className="truncate">
              {presentation?.label ?? trace.name}
            </span>
            <Badge variant="secondary">{completed ? "已完成" : "运行中"}</Badge>
          </span>
        </AccordionTrigger>
        <AccordionContent className="flex flex-col gap-2 pb-3">
          <TracePayload label="参数" value={trace.arguments} />
          {completed ? (
            <TracePayload label="结果" value={trace.result} />
          ) : null}
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function TracePayload({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <pre className="max-h-32 overflow-auto rounded-md bg-muted p-2 text-xs whitespace-pre-wrap">
        {JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}
