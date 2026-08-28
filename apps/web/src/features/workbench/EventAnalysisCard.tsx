import { Clock3, Trash2 } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { format_time } from "@/shared/format";
import type { EventAnalysis } from "@/shared/types";

export function EventAnalysisCard({
  analysis,
  on_seek,
  on_delete,
}: {
  analysis: EventAnalysis;
  on_seek: (seconds: number) => void;
  on_delete: (analysis: EventAnalysis) => void;
}) {
  return (
    <Card data-slot="event-analysis-card">
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <CardTitle>{analysis.title}</CardTitle>
            <CardDescription>
              {analysis.target.source === "marker" ? "范围标记" : "焦点选区"}·{" "}
              {format_time(analysis.target.start_seconds)}–
              {format_time(analysis.target.end_seconds)}
            </CardDescription>
          </div>
          <Button
            type="button"
            size="icon-sm"
            variant="ghost"
            onClick={() => on_delete(analysis)}
            aria-label={`删除事件分析“${analysis.title}”`}
          >
            <Trash2 aria-hidden="true" />
          </Button>
        </div>
        <div className="flex flex-wrap gap-1">
          <Badge
            variant={analysis.status === "valid" ? "secondary" : "outline"}
          >
            {analysis.status === "valid" ? "有效" : "已过期"}
          </Badge>
          <Badge variant="outline">{analysis.depth}</Badge>
          <Badge variant="outline">{analysis.preset_id}</Badge>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 text-sm">
        <p>{analysis.conclusion}</p>
        {analysis.key_points.length > 0 ? (
          <ul className="list-disc space-y-1 pl-5">
            {analysis.key_points.map((point, index) => (
              <li key={`${index}-${point}`}>{point}</li>
            ))}
          </ul>
        ) : null}
        {analysis.evidence.length > 0 ? (
          <div className="grid gap-2" aria-label="时间戳证据">
            {analysis.evidence.map((evidence, index) => (
              <button
                key={`${evidence.start_seconds}-${index}`}
                type="button"
                className="rounded-lg border bg-muted p-2 text-left transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => on_seek(evidence.start_seconds)}
              >
                <span className="mb-1 flex items-center gap-1 font-mono text-xs text-muted-foreground">
                  <Clock3 className="size-3" aria-hidden="true" />
                  {format_time(evidence.start_seconds)} · {evidence.source}
                </span>
                {evidence.text}
              </button>
            ))}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
