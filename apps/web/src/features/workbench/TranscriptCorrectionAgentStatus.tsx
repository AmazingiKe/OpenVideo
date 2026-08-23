import { CircleAlert, CircleCheck, CircleX } from "lucide-react";

import { AiModelSelect } from "@/components/AiModelSelect";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Spinner } from "@/components/ui/spinner";
import type {
  AgentJob,
  AgentQuestionAction,
  AiModelSummary,
} from "@/shared/types";

type TranscriptCorrectionAgentStatusProps = {
  job: AgentJob;
  models: AiModelSummary[];
  replacement_model_id: string | null;
  on_replacement_model_change: (model_id: string | null) => void;
  on_response: (
    action: AgentQuestionAction,
    ai_model_id?: string | null,
  ) => void;
};

export function TranscriptCorrectionAgentStatus({
  job,
  models,
  replacement_model_id,
  on_replacement_model_change,
  on_response,
}: TranscriptCorrectionAgentStatusProps) {
  const is_waiting = job.stage === "waiting_for_input";
  const is_failed = job.stage === "failed";
  const is_complete = job.stage === "complete";
  const is_cancelled = job.stage === "cancelled";
  const is_running = !is_waiting && !is_failed && !is_complete && !is_cancelled;
  const question = job.question;

  return (
    <div className="flex flex-col gap-4" aria-live="polite">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Agent 状态</span>
        <Badge variant={is_failed ? "destructive" : "secondary"}>
          {stage_label(job.stage)}
        </Badge>
      </div>
      <Progress
        value={job.progress_percent}
        aria-label={`转录修正进度 ${Math.round(job.progress_percent)}%`}
      />
      {is_waiting && question ? (
        <Alert>
          <CircleAlert aria-hidden="true" />
          <AlertTitle>需要你的选择</AlertTitle>
          <AlertDescription>{question.message}</AlertDescription>
        </Alert>
      ) : is_failed ? (
        <Alert variant="destructive">
          <CircleX aria-hidden="true" />
          <AlertTitle>修正失败</AlertTitle>
          <AlertDescription>
            {job.error_message ?? "Agent 未能完成转录修正。"}
          </AlertDescription>
        </Alert>
      ) : is_complete ? (
        <Alert>
          <CircleCheck aria-hidden="true" />
          <AlertTitle>修正完成</AlertTitle>
          <AlertDescription>转录已保存为最新版本。</AlertDescription>
        </Alert>
      ) : null}

      {question?.question_type === "context_limit" ? (
        <div className="flex flex-col gap-2">
          <AiModelSelect
            id="transcript-correction-replacement-model"
            label="替换模型"
            models={models}
            value={replacement_model_id}
            on_change={on_replacement_model_change}
            description="更换后仍会优先进行一次完整上下文调用。"
          />
          <Button
            type="button"
            onClick={() => on_response("change_model", replacement_model_id)}
            disabled={!replacement_model_id}
          >
            使用新模型重试
          </Button>
          <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
            <Button
              type="button"
              variant="outline"
              onClick={() => on_response("chunk")}
            >
              授权分块处理
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => on_response("compress")}
            >
              授权压缩上下文
            </Button>
          </div>
          <Button
            type="button"
            variant="ghost"
            onClick={() => on_response("cancel")}
          >
            取消任务
          </Button>
        </div>
      ) : question?.question_type === "transcript_changed" ? (
        <div className="grid grid-cols-1 gap-2 min-[420px]:grid-cols-2">
          <Button type="button" onClick={() => on_response("rerun_latest")}>
            基于最新版本重跑
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => on_response("cancel")}
          >
            取消任务
          </Button>
        </div>
      ) : null}

      {is_running ? (
        <p
          className="flex items-center gap-2 text-xs text-muted-foreground"
          role="status"
        >
          <Spinner />
          {job.message}
        </p>
      ) : null}
    </div>
  );
}

function stage_label(stage: AgentJob["stage"]): string {
  const labels: Record<AgentJob["stage"], string> = {
    pending: "等待中",
    preparing: "准备中",
    invoking_model: "调用模型",
    validating: "校验中",
    waiting_for_input: "等待选择",
    applying: "保存中",
    complete: "已完成",
    failed: "失败",
    cancelled: "已取消",
  };
  return labels[stage];
}
