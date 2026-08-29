import { Clock3, Database, Search } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import { format_time } from "@/shared/format";
import type {
  AgentAnswerStatus,
  AgentCitationValidation,
  AgentConfidence,
  AgentEvidenceBundle,
  AgentEvidenceReference,
  AgentIndexStatus,
  AgentRunMetrics,
} from "@/shared/types";

export function AgentRunMetricsDisclosure({
  metrics,
}: {
  metrics: AgentRunMetrics;
}) {
  const details = metric_details(metrics);
  const total = format_duration(metrics.total_ms);
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="metrics">
        <AccordionTrigger className="py-2">
          <Clock3 />
          {total ? `用时 ${total}` : "查看运行耗时"}
        </AccordionTrigger>
        <AccordionContent>
          <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-2 text-xs">
            {details.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="text-muted-foreground">{label}</dt>
                <dd className="text-right font-medium">{value}</dd>
              </div>
            ))}
          </dl>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function AgentAnswerEvidence({
  confidence,
  answer_status,
  evidence_bundle,
  citation_validation,
  on_seek,
  current_asset_id,
  return_position_seconds,
  on_return,
}: {
  confidence?: AgentConfidence;
  answer_status?: AgentAnswerStatus;
  evidence_bundle?: AgentEvidenceBundle;
  citation_validation?: AgentCitationValidation;
  on_seek?: (
    seconds: number,
    end_seconds?: number,
    evidence?: AgentEvidenceReference,
  ) => void;
  current_asset_id?: string | null;
  return_position_seconds?: number | null;
  on_return?: () => void;
}) {
  if (!confidence && !answer_status && !evidence_bundle) return null;
  const evidence = evidence_bundle?.items ?? [];
  const conflicts = evidence_bundle?.conflicts ?? [];
  const expanded =
    confidence === "low" ||
    answer_status === "provisional" ||
    answer_status === "insufficient";
  return (
    <Accordion
      type="single"
      collapsible
      defaultValue={expanded ? "evidence" : undefined}
    >
      <AccordionItem value="evidence">
        <AccordionTrigger className="py-2">
          <Search />
          <span className="min-w-0 flex-1 truncate text-left">
            {evidence.length > 0
              ? `已参考 ${evidence.length} 项内容`
              : "回答依据"}
          </span>
          {confidence ? (
            <Badge variant={confidence === "low" ? "destructive" : "outline"}>
              {confidence_label(confidence)}
            </Badge>
          ) : null}
        </AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-3">
            {answer_status && answer_status !== "final" ? (
              <Alert
                variant={
                  answer_status === "insufficient" ? "destructive" : "default"
                }
              >
                <AlertTitle>
                  {answer_status === "insufficient" ? "证据不足" : "暂定结论"}
                </AlertTitle>
                <AlertDescription>
                  当前结论尚未达到完整证据覆盖，请结合以下引用核验。
                </AlertDescription>
              </Alert>
            ) : null}
            {citation_validation && !citation_validation.valid ? (
              <Alert variant="destructive">
                <AlertTitle>引用校验未通过</AlertTitle>
                <AlertDescription>
                  {citation_validation.missing_citations
                    ? "回答没有引用检索到的证据。"
                    : `回答包含无效引用：${citation_validation.invalid_citations.join("、")}。`}
                </AlertDescription>
              </Alert>
            ) : null}
            {evidence_bundle ? (
              <div className="flex flex-wrap gap-2" aria-label="证据覆盖">
                <Badge variant="secondary">
                  时间覆盖{" "}
                  {format_temporal_coverage(evidence_bundle.coverage.temporal)}
                </Badge>
                {evidence_bundle.coverage.source_types.map((source_type) => (
                  <Badge key={source_type} variant="outline">
                    {source_type}
                  </Badge>
                ))}
              </div>
            ) : null}
            {conflicts.length > 0 ? (
              <Alert variant="destructive">
                <AlertTitle>发现 {conflicts.length} 组证据冲突</AlertTitle>
                <AlertDescription>
                  <ul className="mt-2 flex list-disc flex-col gap-1 pl-5">
                    {conflicts.map((conflict) => (
                      <li
                        key={`${conflict.reason}-${conflict.evidence_ids.join("-")}`}
                      >
                        {conflict.reason}
                      </li>
                    ))}
                  </ul>
                </AlertDescription>
              </Alert>
            ) : null}
            {evidence.length > 0 ? (
              <ol className="flex flex-col gap-2" aria-label="回答证据">
                {evidence.map((item) => (
                  <li key={item.evidence_id}>
                    <EvidenceReference
                      evidence={item}
                      on_seek={on_seek}
                      current_asset_id={current_asset_id}
                    />
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-sm text-muted-foreground">
                未提供结构化证据。
              </p>
            )}
            {return_position_seconds !== null &&
            return_position_seconds !== undefined &&
            on_return ? (
              <Button type="button" variant="outline" onClick={on_return}>
                返回原播放位置 {format_time(return_position_seconds)}
              </Button>
            ) : null}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

export function AgentIndexStatusDisclosure({
  status,
}: {
  status: AgentIndexStatus;
}) {
  const progress = index_progress(status);
  return (
    <Accordion type="single" collapsible>
      <AccordionItem value="index-status">
        <AccordionTrigger className="py-2">
          {status.state === "initializing" || status.state === "partial" ? (
            <Spinner />
          ) : (
            <Database />
          )}
          <span className="min-w-0 flex-1 truncate text-left">
            {status.stage_label}
          </span>
          <Badge
            variant={status.state === "failed" ? "destructive" : "outline"}
          >
            {index_status_label(status.state)}
          </Badge>
        </AccordionTrigger>
        <AccordionContent>
          <div className="flex flex-col gap-3 text-sm">
            {progress !== null ? (
              <Progress
                value={progress}
                aria-label={`索引覆盖 ${Math.round(progress)}%`}
              />
            ) : null}
            {status.total_documents > 0 ? (
              <p className="text-muted-foreground">
                当前阶段 {status.processed_documents} / {status.total_documents}{" "}
                条
              </p>
            ) : null}
            <p className="text-muted-foreground">
              已收录 {status.indexed_documents} 条证据
              {status.duration_seconds !== null
                ? `，时间覆盖 ${format_time(status.covered_seconds)} / ${format_time(status.duration_seconds)}`
                : ""}
            </p>
            {status.available_capabilities?.length ? (
              <div className="flex flex-wrap gap-2">
                {status.available_capabilities.map((capability) => (
                  <Badge key={capability} variant="secondary">
                    {capability}
                  </Badge>
                ))}
              </div>
            ) : null}
            {status.error_message ? (
              <p className="text-destructive">{status.error_message}</p>
            ) : null}
          </div>
        </AccordionContent>
      </AccordionItem>
    </Accordion>
  );
}

function EvidenceReference({
  evidence,
  on_seek,
  current_asset_id,
}: {
  evidence: AgentEvidenceReference;
  on_seek?: (
    seconds: number,
    end_seconds?: number,
    evidence?: AgentEvidenceReference,
  ) => void;
  current_asset_id?: string | null;
}) {
  const belongs_to_current_asset =
    current_asset_id === undefined || evidence.asset_id === current_asset_id;
  const content = (
    <span className="flex min-w-0 flex-1 flex-col items-start gap-1 text-left">
      <span className="flex max-w-full flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span>{evidence.citation_key}</span>
        <span>
          {format_time(evidence.start_seconds)}–
          {format_time(evidence.end_seconds)}
        </span>
        <span>{evidence.source_type}</span>
        <span className="truncate">{evidence.asset_id}</span>
        {evidence.relation === "conflicts" ? (
          <Badge variant="destructive">冲突</Badge>
        ) : null}
        {!belongs_to_current_asset ? (
          <Badge variant="outline">其他视频</Badge>
        ) : null}
      </span>
      <span className="line-clamp-3 max-w-full text-sm">
        {evidence.excerpt}
      </span>
    </span>
  );
  if (!on_seek || !belongs_to_current_asset) {
    return <div className="flex rounded-md border p-3">{content}</div>;
  }
  return (
    <Button
      type="button"
      variant="outline"
      className="h-auto w-full min-w-0 justify-start p-3 whitespace-normal"
      onClick={() =>
        on_seek(evidence.start_seconds, evidence.end_seconds, evidence)
      }
      aria-label={`跳转到证据 ${format_time(evidence.start_seconds)}`}
    >
      {content}
    </Button>
  );
}

function metric_details(metrics: AgentRunMetrics): [string, string][] {
  const entries: [string, string | null][] = [
    ["总耗时", format_duration(metrics.total_ms)],
    ["首字时间", format_duration(metrics.time_to_first_token_ms)],
    ["模型路由", format_duration(metrics.routing_ms)],
    ["证据检索", format_duration(metrics.retrieval_ms)],
    ["视觉验证", format_duration(metrics.vision_ms)],
    ["模型等待", format_duration(metrics.model_wait_ms)],
    ["工具执行", format_duration(metrics.tool_ms)],
    ["答案生成", format_duration(metrics.generation_ms)],
    [
      "重试次数",
      typeof metrics.retry_count === "number"
        ? String(metrics.retry_count)
        : null,
    ],
    [
      "工具调用",
      typeof metrics.tool_count === "number"
        ? String(metrics.tool_count)
        : null,
    ],
    ["模型角色", model_role_label(metrics.model_role)],
    ["模型", metrics.selected_model_id ?? null],
    ["最终状态", metrics.final_status ?? null],
  ];
  for (const [tool_name, duration] of Object.entries(
    metrics.tool_durations_ms ?? {},
  )) {
    entries.push([`工具 · ${tool_name}`, format_duration(duration)]);
  }
  return entries.filter(
    (entry): entry is [string, string] => entry[1] !== null,
  );
}

function format_duration(milliseconds: number | undefined): string | null {
  if (typeof milliseconds !== "number" || milliseconds < 0) return null;
  if (milliseconds < 1_000) return `${Math.round(milliseconds)} 毫秒`;
  const seconds = milliseconds / 1_000;
  return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
}

function model_role_label(role: AgentRunMetrics["model_role"]): string | null {
  if (role === "fast") return "快速文本";
  if (role === "complex") return "复杂文本";
  if (role === "vision") return "视觉";
  return null;
}

function confidence_label(confidence: AgentConfidence): string {
  return { high: "高置信度", medium: "中置信度", low: "低置信度" }[confidence];
}

function format_temporal_coverage(value: number): string {
  return value >= 0 && value <= 1
    ? `${Math.round(value * 100)}%`
    : String(value);
}

function index_progress(status: AgentIndexStatus): number | null {
  if (status.total_documents <= 0) {
    return null;
  }
  return Math.min(
    100,
    Math.max(0, (status.processed_documents / status.total_documents) * 100),
  );
}

function index_status_label(state: AgentIndexStatus["state"]): string {
  return {
    initializing: "初始化中",
    partial: "部分可用",
    ready: "已就绪",
    failed: "初始化失败",
  }[state];
}
