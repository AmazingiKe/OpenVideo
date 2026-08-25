"""LangGraph 后台 Agent 管理与转录修正状态图。"""

from __future__ import annotations

import asyncio
import hashlib
import json
import sqlite3
from datetime import UTC, datetime
from threading import RLock
from typing import NotRequired, TypedDict

from langgraph.checkpoint.sqlite import SqliteSaver
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from openvideo.core.agent_models import (
    TERMINAL_AGENT_STAGES,
    AgentExecutionMode,
    AgentJob,
    AgentQuestion,
    AgentQuestionAction,
    AgentQuestionType,
    AgentResponse,
    AgentStage,
)
from openvideo.core.transcription_models import Transcript
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.settings import Settings
from openvideo.tools.transcript_correction import (
    LiteLlmTranscriptCorrector,
    TranscriptCorrectionContextLengthError,
)


CONTEXT_LIMIT_QUESTION_MESSAGE = (
    "当前模型无法容纳完整转录。请选择更换模型，或明确授权分块、压缩上下文处理。"
)
TRANSCRIPT_CHANGED_QUESTION_MESSAGE = (
    "任务运行期间转录已被修改。为避免覆盖新内容，请基于最新版本重跑或取消。"
)


class AgentError(RuntimeError):
    """Agent 任务无法创建、回答或恢复时抛出。"""


class AgentState(TypedDict):
    job_id: str
    corrections: dict[int, str]
    issue: str | None
    cancelled: bool
    response: NotRequired[dict[str, object]]


class AgentManager:
    """独立管理可恢复 Agent，避免把通用 Agent 生命周期并入分析任务。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self._jobs = {job.job_id: job for job in library.load_agent_jobs()}
        self._lock = RLock()
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._checkpoint_connection = sqlite3.connect(
            library.agent_checkpoint_database_path,
            timeout=5,
            check_same_thread=False,
        )
        self._checkpoint_connection.execute("PRAGMA journal_mode = WAL")
        self._checkpoint_connection.execute("PRAGMA busy_timeout = 5000")
        self._checkpointer = SqliteSaver(self._checkpoint_connection)
        self._checkpointer.setup()
        self._graph = self._build_graph()

    def create_transcript_correction(
        self,
        asset_id: str,
        segment_indices: list[int] | None,
        ai_model_id: str,
    ) -> AgentJob:
        transcript = self.library.load_transcript(asset_id)
        if transcript is None:
            raise AgentError("该视频还没有转写结果")
        if not transcript.segments:
            raise AgentError("该视频没有可修正的转录片段")
        if self.settings.ai_model(ai_model_id) is None:
            raise AgentError("所选 AI 模型不存在，请在设置中重新选择")
        active_job = self._active_job_for_asset(asset_id)
        if active_job:
            return active_job
        resolved_indices = _validated_indices(len(transcript.segments), segment_indices)
        job = AgentJob(
            job_id=f"agent-{uuid7().hex}",
            asset_id=asset_id,
            ai_model_id=ai_model_id,
            segment_indices=None if segment_indices is None else resolved_indices,
            transcript_checksum=transcript_checksum(transcript),
        )
        self._save(job)
        return job.model_copy(deep=True)

    def start(self, job_id: str) -> None:
        with self._lock:
            current_task = self._tasks.get(job_id)
            if current_task and not current_task.done():
                return
            self._tasks[job_id] = asyncio.create_task(self._run(job_id))

    def restore(self) -> None:
        for job in self.list_jobs():
            if (
                job.stage not in TERMINAL_AGENT_STAGES
                and job.stage != AgentStage.WAITING_FOR_INPUT
            ):
                self.start(job.job_id)

    def get(self, job_id: str) -> AgentJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def list_jobs(
        self, asset_id: str | None = None, active: bool = False
    ) -> list[AgentJob]:
        with self._lock:
            jobs = list(self._jobs.values())
        if asset_id is not None:
            jobs = [job for job in jobs if job.asset_id == asset_id]
        if active:
            jobs = [job for job in jobs if job.stage not in TERMINAL_AGENT_STAGES]
        return [
            job.model_copy(deep=True)
            for job in sorted(jobs, key=lambda item: item.created_at, reverse=True)
        ]

    def respond(self, job_id: str, response: AgentResponse) -> AgentJob:
        job = self.get(job_id)
        if job is None:
            raise AgentError("Agent 任务不存在")
        if job.stage != AgentStage.WAITING_FOR_INPUT or job.question is None:
            raise AgentError("Agent 任务当前不等待回答")
        if response.question_id != job.question.question_id:
            raise AgentError("Agent 问题已更新，请刷新后重试")
        if response.action not in job.question.actions:
            raise AgentError("当前问题不支持该操作")
        if response.action == AgentQuestionAction.CHANGE_MODEL:
            if not response.ai_model_id:
                raise AgentError("更换模型时必须选择新模型")
            if self.settings.ai_model(response.ai_model_id) is None:
                raise AgentError("所选 AI 模型不存在，请在设置中重新选择")
        self._update(job, AgentStage.PENDING, job.progress_percent, "正在处理回答")
        self._start_resume(job_id, response)
        return self._require_job(job_id)

    def has_active_jobs(self) -> bool:
        return any(job.stage not in TERMINAL_AGENT_STAGES for job in self.list_jobs())

    async def close(self) -> None:
        with self._lock:
            tasks = list(self._tasks.values())
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.to_thread(self._close_checkpoint_connection)

    async def cancel_assets(self, asset_ids: set[str]) -> bool:
        jobs = [job for job in self.list_jobs(active=True) if job.asset_id in asset_ids]
        with self._lock:
            tasks = [
                self._tasks[job.job_id] for job in jobs if job.job_id in self._tasks
            ]
        if any(not task.done() for task in tasks):
            # LangGraph 在线程中执行，线程真实结束前永久删除必须保持冲突状态。
            return False
        for job in jobs:
            self._update(
                job,
                AgentStage.CANCELLED,
                job.progress_percent,
                "素材已请求删除，Agent 任务已取消",
            )
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)
        return all(task.done() for task in tasks)

    def _close_checkpoint_connection(self) -> None:
        with self._checkpointer.lock:
            self._checkpoint_connection.close()

    def _start_resume(self, job_id: str, response: AgentResponse) -> None:
        with self._lock:
            current_task = self._tasks.get(job_id)
            self._tasks[job_id] = asyncio.create_task(
                self._resume_after(
                    current_task,
                    job_id,
                    response,
                )
            )

    async def _resume_after(
        self,
        current_task: asyncio.Task[None] | None,
        job_id: str,
        response: AgentResponse,
    ) -> None:
        if current_task and not current_task.done():
            await current_task
        await self._run(job_id, Command(resume=response.model_dump(mode="json")))

    async def _run(
        self,
        job_id: str,
        graph_input: AgentState | Command | None = None,
    ) -> None:
        config = {"configurable": {"thread_id": job_id}}
        try:
            if graph_input is None:
                snapshot = self._graph.get_state(config)
                graph_input = (
                    None
                    if snapshot.values
                    else AgentState(
                        job_id=job_id,
                        corrections={},
                        issue=None,
                        cancelled=False,
                    )
                )
            await asyncio.to_thread(self._graph.invoke, graph_input, config)
        except Exception as error:
            self._fail(job_id, str(error) or "Agent 执行失败")

    def _build_graph(self):
        builder = StateGraph(AgentState)
        builder.add_node("prepare", self._prepare)
        builder.add_node("invoke_model", self._invoke_model)
        builder.add_node("context_question", self._context_question)
        builder.add_node("validate", self._validate)
        builder.add_node("apply", self._apply)
        builder.add_node("transcript_question", self._transcript_question)
        builder.add_edge(START, "prepare")
        builder.add_conditional_edges(
            "prepare",
            lambda state: (
                "transcript_question"
                if state["issue"] == "transcript_changed"
                else "invoke_model"
            ),
        )
        builder.add_conditional_edges(
            "invoke_model",
            lambda state: (
                "context_question" if state["issue"] == "context_limit" else "validate"
            ),
        )
        builder.add_conditional_edges(
            "context_question",
            lambda state: END if state["cancelled"] else "invoke_model",
        )
        builder.add_edge("validate", "apply")
        builder.add_conditional_edges(
            "apply",
            lambda state: (
                "transcript_question" if state["issue"] == "transcript_changed" else END
            ),
        )
        builder.add_conditional_edges(
            "transcript_question",
            lambda state: END if state["cancelled"] else "invoke_model",
        )
        return builder.compile(checkpointer=self._checkpointer)

    def _prepare(self, state: AgentState) -> dict[str, object]:
        job = self._require_job(state["job_id"])
        transcript = self._require_transcript(job.asset_id)
        if transcript_checksum(transcript) != job.transcript_checksum:
            self._set_question(job, AgentQuestionType.TRANSCRIPT_CHANGED)
            return {"issue": "transcript_changed", "corrections": {}}
        self._update(job, AgentStage.PREPARING, 10, "正在读取完整转录")
        return {"issue": None, "corrections": {}, "cancelled": False}

    def _invoke_model(self, state: AgentState) -> dict[str, object]:
        job = self._require_job(state["job_id"])
        transcript = self._require_transcript(job.asset_id)
        model = self.settings.ai_model(job.ai_model_id)
        if model is None:
            raise AgentError("Agent 使用的 AI 模型已被删除")
        self._update(job, AgentStage.INVOKING_MODEL, 35, "正在调用模型校对转录")
        corrector = LiteLlmTranscriptCorrector(model)
        target_indices = (
            job.segment_indices
            if job.segment_indices is not None
            else list(range(len(transcript.segments)))
        )
        try:
            if job.execution_mode == AgentExecutionMode.CHUNKED:
                corrections = corrector.correct_chunked(transcript, target_indices)
            elif job.execution_mode == AgentExecutionMode.COMPRESSED:
                corrections = corrector.correct_with_compressed_context(
                    transcript, target_indices
                )
            else:
                corrections = corrector.correct(transcript, target_indices)
        except TranscriptCorrectionContextLengthError:
            self._set_question(job, AgentQuestionType.CONTEXT_LIMIT)
            return {"issue": "context_limit", "corrections": {}}
        return {"issue": None, "corrections": corrections}

    def _context_question(self, state: AgentState) -> dict[str, object]:
        job = self._require_job(state["job_id"])
        question = self._ensure_question(job, AgentQuestionType.CONTEXT_LIMIT)
        response = AgentResponse.model_validate(
            interrupt(question.model_dump(mode="json"))
        )
        if response.action == AgentQuestionAction.CANCEL:
            self._cancel(job)
            return {"cancelled": True, "issue": None}
        if response.action == AgentQuestionAction.CHANGE_MODEL:
            if (
                not response.ai_model_id
                or self.settings.ai_model(response.ai_model_id) is None
            ):
                raise AgentError("所选 AI 模型不存在，请在设置中重新选择")
            job.ai_model_id = response.ai_model_id
            job.execution_mode = AgentExecutionMode.AUTOMATIC
        elif response.action == AgentQuestionAction.CHUNK:
            job.execution_mode = AgentExecutionMode.CHUNKED
        elif response.action == AgentQuestionAction.COMPRESS:
            job.execution_mode = AgentExecutionMode.COMPRESSED
        job.question = None
        self._save(job)
        return {"cancelled": False, "issue": None}

    def _validate(self, state: AgentState) -> dict[str, object]:
        job = self._require_job(state["job_id"])
        transcript = self._require_transcript(job.asset_id)
        allowed_indices = set(
            job.segment_indices
            if job.segment_indices is not None
            else range(len(transcript.segments))
        )
        corrections = state["corrections"]
        if any(
            index not in allowed_indices
            or not isinstance(text, str)
            or not text.strip()
            for index, text in corrections.items()
        ):
            raise AgentError("模型返回了无法应用的转录片段")
        self._update(job, AgentStage.VALIDATING, 75, "正在校验模型返回结果")
        return {"issue": None}

    def _apply(self, state: AgentState) -> dict[str, object]:
        job = self._require_job(state["job_id"])
        transcript = self._require_transcript(job.asset_id)
        if transcript_checksum(transcript) != job.transcript_checksum:
            self._set_question(job, AgentQuestionType.TRANSCRIPT_CHANGED)
            return {"issue": "transcript_changed"}
        self._update(job, AgentStage.APPLYING, 90, "正在保存转录修正")
        updated_segments = list(transcript.segments)
        for index, text in state["corrections"].items():
            updated_segments[index] = updated_segments[index].model_copy(
                update={"text": text.strip()}
            )
        if state["corrections"]:
            self.library.save_transcript(
                transcript.model_copy(update={"segments": updated_segments})
            )
        self._update(job, AgentStage.COMPLETE, 100, "转录修正完成")
        return {"issue": None}

    def _transcript_question(self, state: AgentState) -> dict[str, object]:
        job = self._require_job(state["job_id"])
        question = self._ensure_question(job, AgentQuestionType.TRANSCRIPT_CHANGED)
        response = AgentResponse.model_validate(
            interrupt(question.model_dump(mode="json"))
        )
        if response.action == AgentQuestionAction.CANCEL:
            self._cancel(job)
            return {"cancelled": True, "issue": None}
        if response.action != AgentQuestionAction.RERUN_LATEST:
            raise AgentError("当前问题不支持该操作")
        transcript = self._require_transcript(job.asset_id)
        job.transcript_checksum = transcript_checksum(transcript)
        job.question = None
        self._save(job)
        return {
            "cancelled": False,
            "issue": None,
            "corrections": {},
        }

    def _set_question(self, job: AgentJob, question_type: AgentQuestionType) -> None:
        if job.question and job.question.question_type == question_type:
            question = job.question
        elif question_type == AgentQuestionType.CONTEXT_LIMIT:
            question = AgentQuestion(
                question_id=f"question-{uuid7().hex}",
                question_type=question_type,
                message=CONTEXT_LIMIT_QUESTION_MESSAGE,
                actions=[
                    AgentQuestionAction.CHANGE_MODEL,
                    AgentQuestionAction.CHUNK,
                    AgentQuestionAction.COMPRESS,
                    AgentQuestionAction.CANCEL,
                ],
            )
        else:
            question = AgentQuestion(
                question_id=f"question-{uuid7().hex}",
                question_type=question_type,
                message=TRANSCRIPT_CHANGED_QUESTION_MESSAGE,
                actions=[
                    AgentQuestionAction.RERUN_LATEST,
                    AgentQuestionAction.CANCEL,
                ],
            )
        job.question = question
        self._update(
            job, AgentStage.WAITING_FOR_INPUT, job.progress_percent, question.message
        )

    def _ensure_question(
        self,
        job: AgentJob,
        question_type: AgentQuestionType,
    ) -> AgentQuestion:
        if job.question is None or job.question.question_type != question_type:
            self._set_question(job, question_type)
        if job.question is None:
            raise AgentError("Agent 问题状态无效")
        return job.question

    def _cancel(self, job: AgentJob) -> None:
        job.question = None
        self._update(job, AgentStage.CANCELLED, job.progress_percent, "任务已取消")

    def _fail(self, job_id: str, message: str) -> None:
        job = self.get(job_id)
        if job is None or job.stage in TERMINAL_AGENT_STAGES:
            return
        self._update(
            job, AgentStage.FAILED, job.progress_percent, "转录修正失败", message
        )

    def _update(
        self,
        job: AgentJob,
        stage: AgentStage,
        progress_percent: float,
        message: str,
        error_message: str | None = None,
    ) -> None:
        job.stage = stage
        job.progress_percent = max(0, min(progress_percent, 100))
        job.message = message
        job.error_message = error_message
        job.updated_at = datetime.now(UTC)
        self._save(job)

    def _save(self, job: AgentJob) -> None:
        with self._lock:
            self._jobs[job.job_id] = job.model_copy(deep=True)
            self.library.save_agent_job(job)

    def _require_job(self, job_id: str) -> AgentJob:
        job = self.get(job_id)
        if job is None:
            raise AgentError("Agent 任务不存在")
        return job

    def _require_transcript(self, asset_id: str) -> Transcript:
        transcript = self.library.load_transcript(asset_id)
        if transcript is None:
            raise AgentError("该视频还没有转写结果")
        return transcript

    def _active_job_for_asset(self, asset_id: str) -> AgentJob | None:
        return next(iter(self.list_jobs(asset_id, active=True)), None)


def transcript_checksum(transcript: Transcript) -> str:
    payload = {
        "language": transcript.language,
        "segments": [
            {
                "start_seconds": segment.start_seconds,
                "end_seconds": segment.end_seconds,
                "text": segment.text,
            }
            for segment in transcript.segments
        ],
    }
    serialized = json.dumps(
        payload,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(serialized.encode("utf-8")).hexdigest()


def _validated_indices(
    segment_count: int,
    segment_indices: list[int] | None,
) -> list[int]:
    if segment_indices is None:
        return list(range(segment_count))
    resolved_indices = list(dict.fromkeys(segment_indices))
    if not resolved_indices:
        raise AgentError("请先在时间线上选择转录片段")
    if any(index < 0 or index >= segment_count for index in resolved_indices):
        raise AgentError("修正请求包含不存在的转录片段")
    return resolved_indices
