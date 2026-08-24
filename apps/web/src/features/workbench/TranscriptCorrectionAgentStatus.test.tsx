import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import type {
  AgentJob,
  AgentQuestionAction,
  AiModelSummary,
} from "@/shared/types";
import { TranscriptCorrectionAgentStatus } from "./TranscriptCorrectionAgentStatus";

const MODELS: AiModelSummary[] = [
  {
    model_id: "model-019c0000000070008000000000000000",
    name: "长上下文模型",
    litellm_model: "openai/example",
    tool_calling_mode: "auto",
    input_modalities: ["text"],
  },
];

describe("TranscriptCorrectionAgentStatus", () => {
  it("offers all context-limit recovery actions", () => {
    const respond =
      vi.fn<
        (action: AgentQuestionAction, ai_model_id?: string | null) => void
      >();
    render_status(context_limit_job(), respond);

    fireEvent.click(screen.getByRole("button", { name: "使用新模型重试" }));
    fireEvent.click(screen.getByRole("button", { name: "授权分块处理" }));
    fireEvent.click(screen.getByRole("button", { name: "授权压缩上下文" }));
    fireEvent.click(screen.getByRole("button", { name: "取消任务" }));

    expect(respond).toHaveBeenNthCalledWith(
      1,
      "change_model",
      MODELS[0].model_id,
    );
    expect(respond).toHaveBeenNthCalledWith(2, "chunk");
    expect(respond).toHaveBeenNthCalledWith(3, "compress");
    expect(respond).toHaveBeenNthCalledWith(4, "cancel");
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-label",
      "转录修正进度 35%",
    );
  });

  it("protects a concurrently changed transcript with rerun or cancel", () => {
    const respond =
      vi.fn<
        (action: AgentQuestionAction, ai_model_id?: string | null) => void
      >();
    render_status(
      {
        ...context_limit_job(),
        question: {
          question_id: "question-019c0000000070008000000000000001",
          question_type: "transcript_changed",
          message: "任务运行期间转录已被修改。",
          actions: ["rerun_latest", "cancel"],
        },
      },
      respond,
    );

    fireEvent.click(screen.getByRole("button", { name: "基于最新版本重跑" }));
    expect(respond).toHaveBeenCalledWith("rerun_latest");
  });
});

function render_status(
  job: AgentJob,
  on_response: (
    action: AgentQuestionAction,
    ai_model_id?: string | null,
  ) => void,
) {
  return render(
    <TranscriptCorrectionAgentStatus
      job={job}
      models={MODELS}
      replacement_model_id={MODELS[0].model_id}
      on_replacement_model_change={vi.fn()}
      on_response={on_response}
    />,
  );
}

function context_limit_job(): AgentJob {
  return {
    job_id: "agent-019c0000000070008000000000000000",
    asset_id: "019c0000-0000-7000-8000-000000000000",
    agent_type: "transcript_correction",
    execution_mode: "automatic",
    stage: "waiting_for_input",
    progress_percent: 35,
    message: "需要选择",
    ai_model_id: MODELS[0].model_id,
    segment_indices: [0],
    transcript_checksum: "checksum",
    question: {
      question_id: "question-019c0000000070008000000000000000",
      question_type: "context_limit",
      message: "当前模型无法容纳完整转录。",
      actions: ["change_model", "chunk", "compress", "cancel"],
    },
    error_message: null,
    created_at: "2026-08-24T00:00:00Z",
    updated_at: "2026-08-24T00:00:00Z",
  };
}
