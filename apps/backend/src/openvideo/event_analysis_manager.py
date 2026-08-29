from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from threading import RLock

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from openvideo.core.event_analysis_models import (
    EventAnalysis,
    EventAnalysisEvidence,
    EventAnalysisJob,
    EventAnalysisJobCreate,
    EventAnalysisJobStage,
    EventAnalysisTarget,
    FocusSelectionEventAnalysisTarget,
    MarkerEventAnalysisTarget,
    TERMINAL_EVENT_ANALYSIS_JOB_STAGES,
    build_event_analysis_source_summary,
    timeline_evidence_for_target,
    transcript_evidence_for_target,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAssetStatus, MediaSegment
from openvideo.core.transcription_models import TranscriptSegment
from openvideo.settings import Settings
from openvideo.tools.llm import LlmCompletionError, complete_text


EVENT_ANALYSIS_TIMEOUT_SECONDS = 120
EVENT_ANALYSIS_MAX_TOKENS = 8_000


class EventAnalysisError(RuntimeError):
    """事件分析请求无法在当前素材状态下可靠完成。"""


class EventAnalysisOutput(BaseModel):
    model_config = ConfigDict(extra="forbid")

    title: str = Field(min_length=1, max_length=300)
    conclusion: str = Field(min_length=1, max_length=20_000)
    key_points: list[str] = Field(default_factory=list, max_length=100)
    evidence: list[EventAnalysisEvidence] = Field(default_factory=list, max_length=200)


class EventAnalysisManager:
    """批量任务按目标独立生成并追加结果，保留可追溯的历史版本。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self._jobs = {
            job.job_id: job for job in self.library.load_event_analysis_jobs()
        }
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._lock = RLock()

    def create(self, asset_id: str, request: EventAnalysisJobCreate) -> EventAnalysisJob:
        asset = self.library.get(asset_id)
        if asset is None or asset.status != MediaAssetStatus.READY:
            raise EventAnalysisError("视频尚未就绪，无法分析")
        if self.library.load_transcript(asset_id) is None:
            raise EventAnalysisError("请先完成视频转录")
        if self.settings.ai_model(request.ai_model_id) is None:
            raise EventAnalysisError("所选 AI 模型不存在")

        targets = []
        if request.marker_ids:
            markers = {
                marker.marker_id: marker
                for marker in self.library.load_markers(asset_id)
            }
            for marker_id in request.marker_ids:
                marker = markers.get(marker_id)
                if marker is None:
                    raise EventAnalysisError("事件分析引用的标记不存在")
                if marker.end_seconds is None:
                    raise EventAnalysisError("只有范围标记可以作为事件分析目标")
                targets.append(
                    MarkerEventAnalysisTarget(
                        marker_id=marker.marker_id,
                        start_seconds=marker.start_seconds,
                        end_seconds=marker.end_seconds,
                    )
                )
        else:
            selection = self.library.load_focus_selection(asset_id)
            if selection is None or not selection.is_complete:
                raise EventAnalysisError("请先设置完整且有效的 In/Out 焦点选区")
            targets.append(
                FocusSelectionEventAnalysisTarget(
                    selection_id=selection.selection_id,
                    start_seconds=selection.in_seconds,
                    end_seconds=selection.out_seconds,
                )
            )

        job = EventAnalysisJob(
            job_id=f"event-analysis-job-{uuid7().hex}",
            asset_id=asset_id,
            targets=targets,
            preset_id=request.preset_id,
            preset_version=request.preset_version,
            depth=request.depth,
            user_input=request.user_input.strip() if request.user_input else None,
            ai_model_id=request.ai_model_id,
        )
        with self._lock:
            self._jobs[job.job_id] = job
        self.library.save_event_analysis_job(job)
        return job.model_copy(deep=True)

    def start(self, job_id: str) -> None:
        with self._lock:
            task = self._tasks.get(job_id)
            if task is not None and not task.done():
                return
            task = asyncio.create_task(self._run(job_id))
            self._tasks[job_id] = task
            task.add_done_callback(lambda _: self._discard_task(job_id))

    def restore(self) -> None:
        now = datetime.now(UTC)
        for job in list(self._jobs.values()):
            if job.stage not in TERMINAL_EVENT_ANALYSIS_JOB_STAGES:
                failed = job.model_copy(
                    update={
                        "stage": EventAnalysisJobStage.FAILED,
                        "message": "应用重启中断了事件分析",
                        "error_message": "应用重启中断了事件分析",
                        "updated_at": now,
                    }
                )
                self._save_job(failed)

    def get(self, job_id: str) -> EventAnalysisJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
            return job.model_copy(deep=True) if job else None

    def has_active_jobs(self) -> bool:
        return any(not task.done() for task in self._tasks.values())

    async def close(self) -> None:
        tasks = list(self._tasks.values())
        for task in tasks:
            task.cancel()
        if tasks:
            await asyncio.gather(*tasks, return_exceptions=True)

    async def _run(self, job_id: str) -> None:
        job = self.get(job_id)
        if job is None:
            return
        try:
            self._save_job(
                job.model_copy(
                    update={
                        "stage": EventAnalysisJobStage.RUNNING,
                        "message": "正在分析事件",
                        "updated_at": datetime.now(UTC),
                    }
                )
            )
            results: list[EventAnalysis] = []
            for position, target in enumerate(job.targets):
                result = await asyncio.to_thread(self._analyze_target, job, target)
                self.library.append_event_analyses(job.asset_id, [result])
                results.append(result)
                current = self.get(job_id) or job
                self._save_job(
                    current.model_copy(
                        update={
                            "progress_percent": (position + 1) / len(job.targets) * 100,
                            "message": f"已完成 {position + 1}/{len(job.targets)} 个事件",
                            "result_ids": [item.event_analysis_id for item in results],
                            "updated_at": datetime.now(UTC),
                        }
                    )
                )
            current = self.get(job_id) or job
            self._save_job(
                current.model_copy(
                    update={
                        "stage": EventAnalysisJobStage.COMPLETE,
                        "progress_percent": 100,
                        "message": "事件分析完成",
                        "updated_at": datetime.now(UTC),
                    }
                )
            )
        except asyncio.CancelledError:
            raise
        except Exception as error:
            current = self.get(job_id) or job
            self._save_job(
                current.model_copy(
                    update={
                        "stage": EventAnalysisJobStage.FAILED,
                        "message": "事件分析失败",
                        "error_message": str(error),
                        "updated_at": datetime.now(UTC),
                    }
                )
            )

    def _analyze_target(
        self,
        job: EventAnalysisJob,
        target: EventAnalysisTarget,
    ) -> EventAnalysis:
        transcript = self.library.load_transcript(job.asset_id)
        if transcript is None:
            raise EventAnalysisError("转录已被删除")
        segments = self.library.load_segments(job.asset_id)
        transcript_evidence = transcript_evidence_for_target(
            target,
            transcript.segments,
        )
        timeline_evidence = timeline_evidence_for_target(target, segments)
        model = self.settings.ai_model(job.ai_model_id)
        if model is None:
            raise EventAnalysisError("所选 AI 模型不存在")
        try:
            content = complete_text(
                model,
                _event_analysis_messages(
                    job,
                    target,
                    transcript_evidence,
                    timeline_evidence,
                ),
                EVENT_ANALYSIS_TIMEOUT_SECONDS,
                EVENT_ANALYSIS_MAX_TOKENS,
                True,
            )
            output = EventAnalysisOutput.model_validate_json(_strip_code_fence(content))
        except (LlmCompletionError, ValidationError, ValueError) as error:
            raise EventAnalysisError(f"事件分析输出无效：{error}") from error
        if any(
            evidence.start_seconds < target.start_seconds
            or evidence.end_seconds > target.end_seconds
            for evidence in output.evidence
        ):
            raise EventAnalysisError("事件分析证据超出目标时间范围")
        return EventAnalysis(
            event_analysis_id=f"event-analysis-{uuid7().hex}",
            asset_id=job.asset_id,
            target=target,
            title=output.title,
            conclusion=output.conclusion,
            key_points=output.key_points,
            evidence=output.evidence,
            preset_id=job.preset_id,
            preset_version=job.preset_version,
            depth=job.depth,
            user_input=job.user_input,
            ai_model_id=job.ai_model_id,
            source_summary=build_event_analysis_source_summary(
                target,
                transcript_evidence,
                timeline_evidence,
            ),
        )

    def _save_job(self, job: EventAnalysisJob) -> None:
        with self._lock:
            self._jobs[job.job_id] = job
        self.library.save_event_analysis_job(job)

    def _discard_task(self, job_id: str) -> None:
        with self._lock:
            self._tasks.pop(job_id, None)


def _event_analysis_messages(
    job: EventAnalysisJob,
    target: EventAnalysisTarget,
    transcript: list[TranscriptSegment],
    timeline: list[MediaSegment],
) -> list[dict[str, str]]:
    context = {
        "target": target.model_dump(mode="json"),
        "preset": {"preset_id": job.preset_id, "version": job.preset_version},
        "depth": job.depth.value,
        "user_input": job.user_input,
        "transcript": [item.model_dump(mode="json") for item in transcript],
        "timeline_evidence": [item.model_dump(mode="json") for item in timeline],
    }
    return [
        {
            "role": "system",
            "content": (
                "你是视频事件分析器。只返回 JSON，不返回 Markdown。输出字段必须为 title、"
                "conclusion、key_points、evidence；evidence 每项包含 start_seconds、"
                "end_seconds、text、source，source 只能是 transcript、timeline、visual、ocr。"
            ),
        },
        {"role": "user", "content": json.dumps(context, ensure_ascii=False)},
    ]


def _strip_code_fence(content: str) -> str:
    stripped = content.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        first_line_end = stripped.find("\n")
        if first_line_end >= 0:
            return stripped[first_line_end + 1 : -3].strip()
    return stripped
