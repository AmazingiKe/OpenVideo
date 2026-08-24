"""标记 Agent 只生成可审计建议，标记写入集中发生在批量审批阶段。"""

from __future__ import annotations

import asyncio
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime

from pydantic import BaseModel, Field, model_validator

from openvideo.agent_runtime import (
    AgentPreset,
    AgentRuntime,
    AgentSessionStore,
    AgentTool,
    AgentToolRegistry,
    new_agent_run,
)
from openvideo.core.agent_runtime_models import (
    AgentEvent,
    AgentRun,
    AgentRunStage,
    AgentSession,
)
from openvideo.core.ai_models import IMAGE_INPUT_MODALITY, AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.marker_agent_models import (
    MarkerAgentMessageRequest,
    MarkerAgentSession,
    MarkerAgentSessionState,
    MarkerProposal,
    MarkerProposalChange,
    MarkerProposalOperation,
    MarkerProposalStatus,
    MarkerRetrievalMode,
)
from openvideo.core.media_models import MediaMarker, MediaSegment
from openvideo.settings import Settings
from openvideo.tools.frames import extract_frames
from openvideo.tools.llm import LiteLlmAgentAdapter
from openvideo.tools.vision import LiteLlmVision


MARKER_AGENT_TYPE = "marker"
MARKER_SESSION_TITLE = "新标记会话"
MARKER_SESSION_TITLE_LENGTH = 60
MARKER_AGENT_PERSONA = """你是 OpenVideo 的标记 Agent，只处理当前视频。
先检索证据并读取现有标记，再判断是否需要新增、修改、合并或删除标记。
任何改动都必须调用 propose_marker_changes 创建整批待审批建议；你没有直接写入标记的权限。
建议必须给出简洁理由和可定位的证据，不得声称待审批建议已经执行。"""


class MarkerAgentError(RuntimeError):
    """标记 Agent 无法在当前资料库状态下安全完成请求。"""


class MarkerAgentNotFoundError(MarkerAgentError):
    """请求的标记 Agent 资源不存在或不属于当前视频。"""


class MarkerProposalConflictError(MarkerAgentError):
    """建议基于的标记快照已变化，整批操作不能继续。"""


class EvidenceSearchInput(BaseModel):
    query: str | None = Field(default=None, max_length=500)
    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    limit: int = Field(default=12, ge=1, le=30)

    @model_validator(mode="after")
    def validate_range(self) -> "EvidenceSearchInput":
        if (
            self.start_seconds is not None
            and self.end_seconds is not None
            and self.end_seconds <= self.start_seconds
        ):
            raise ValueError("结束时间必须晚于开始时间")
        return self


class InspectFramesInput(BaseModel):
    start_seconds: float = Field(ge=0)
    end_seconds: float = Field(gt=0)
    question: str = Field(min_length=1, max_length=1_000)

    @model_validator(mode="after")
    def validate_range(self) -> "InspectFramesInput":
        if self.end_seconds <= self.start_seconds:
            raise ValueError("结束时间必须晚于开始时间")
        return self


class ReadMarkersInput(BaseModel):
    pass


class ProposedMarkerChangeInput(BaseModel):
    operation: MarkerProposalOperation
    marker_ids: list[str] = Field(default_factory=list, max_length=100)
    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    title: str = Field(default="", max_length=200)
    tags: list[str] = Field(default_factory=list)
    reason: str = Field(min_length=1, max_length=2_000)
    evidence: list[str] = Field(default_factory=list, max_length=20)


class ProposeMarkerChangesInput(BaseModel):
    changes: list[ProposedMarkerChangeInput] = Field(min_length=1, max_length=100)


@dataclass
class MarkerTurnState:
    retrieval_mode: MarkerRetrievalMode
    text_searched: bool = False
    vision_inspected: bool = False


class MarkerAgentManager:
    """复用通用 Runtime，并把检索白名单与批量审批约束收口在标记领域。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self._tasks: set[asyncio.Task[None]] = set()
        self._agent_runtimes: dict[str, AgentRuntime] = {}
        self._turn_states: dict[str, MarkerTurnState] = {}

    async def close(self) -> None:
        if self._tasks:
            await asyncio.gather(*self._tasks, return_exceptions=True)

    def has_active_jobs(self) -> bool:
        return any(not task.done() for task in self._tasks)

    def sessions(self, asset_id: str) -> list[MarkerAgentSession]:
        self._require_asset(asset_id)
        return [
            MarkerAgentSession(session=session, asset_id=asset_id)
            for session in self.library.load_marker_agent_sessions(asset_id)
        ]

    def create_session(self, asset_id: str) -> MarkerAgentSessionState:
        self._require_asset(asset_id)
        session = AgentSession(
            session_id=f"session-{uuid7().hex}",
            agent_type=MARKER_AGENT_TYPE,
            title=MARKER_SESSION_TITLE,
        )
        self.library.save_marker_agent_session(session, asset_id)
        return MarkerAgentSessionState(session=session, asset_id=asset_id)

    def session_state(self, session_id: str) -> MarkerAgentSessionState:
        try:
            session = self.library.load_agent_session(session_id)
            asset_id = self.library.load_marker_agent_session_binding(session_id)
        except ValueError as error:
            raise MarkerAgentNotFoundError("标记 Agent 会话不存在") from error
        if (
            session is None
            or asset_id is None
            or session.agent_type != MARKER_AGENT_TYPE
        ):
            raise MarkerAgentNotFoundError("标记 Agent 会话不存在")
        return MarkerAgentSessionState(
            session=session,
            asset_id=asset_id,
            events=self.library.load_agent_events(session_id),
            proposals=self.library.load_marker_proposals(session_id),
        )

    def delete_session(self, session_id: str) -> None:
        self.session_state(session_id)
        active_stages = {AgentRunStage.PENDING, AgentRunStage.RUNNING}
        if any(
            run.session_id == session_id and run.stage in active_stages
            for run in self.library.load_agent_runs()
        ):
            raise MarkerAgentError("Agent 正在运行，暂时不能删除该会话")
        if not self.library.delete_agent_session(session_id):
            raise MarkerAgentNotFoundError("标记 Agent 会话不存在")

    def create_message(
        self, session_id: str, request: MarkerAgentMessageRequest
    ) -> AgentRun:
        state = self.session_state(session_id)
        active_stages = {AgentRunStage.PENDING, AgentRunStage.RUNNING}
        if any(
            run.session_id == session_id and run.stage in active_stages
            for run in self.library.load_agent_runs()
        ):
            raise MarkerAgentError("当前会话已有正在运行的任务")
        content = request.content.strip()
        model = self.settings.ai_model(request.ai_model_id)
        if model is None:
            raise MarkerAgentError("所选 AI 模型不存在")
        retrieval_mode = self._turn_retrieval_mode(request.retrieval_mode, content)
        if (
            retrieval_mode == MarkerRetrievalMode.VISION
            and IMAGE_INPUT_MODALITY not in model.input_modalities
        ):
            raise MarkerAgentError("当前模型不支持图像输入，请切换视觉模型")
        if not state.events:
            self.library.save_agent_session(
                state.session.model_copy(
                    update={
                        "title": content.splitlines()[0][:MARKER_SESSION_TITLE_LENGTH],
                        "updated_at": datetime.now(UTC),
                    }
                )
            )
        run = new_agent_run(session_id)
        self.library.save_agent_run(run)
        self._turn_states[session_id] = MarkerTurnState(retrieval_mode)
        registry = self._tool_registry(
            session_id, state.asset_id, retrieval_mode, model
        )
        runtime = AgentRuntime(
            AgentSessionStore(self.library), registry, LiteLlmAgentAdapter()
        )
        self._agent_runtimes[run.run_id] = runtime
        allowed_tools = self._allowed_tools(retrieval_mode)
        mode_instruction = {
            MarkerRetrievalMode.TRANSCRIPT: "本轮只能使用带时间戳转录证据，禁止检查画面。",
            MarkerRetrievalMode.AUTO: "本轮先搜索转录和已有分析；证据不足时再检查画面。",
            MarkerRetrievalMode.VISION: "本轮必须调用 inspect_frames 检查相关画面。",
        }[retrieval_mode]
        preset = AgentPreset(
            persona=f"{MARKER_AGENT_PERSONA}\n{mode_instruction}",
            dynamic_context=lambda: self._context(state.asset_id),
            allowed_tools=allowed_tools,
        )
        task = asyncio.create_task(
            self._execute_run(runtime, run, model, preset, content)
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return run

    async def _execute_run(
        self,
        runtime: AgentRuntime,
        run: AgentRun,
        model: AiModelConfiguration,
        preset: AgentPreset,
        content: str,
    ) -> None:
        try:
            await runtime.run(run, model, preset, content)
        finally:
            self._agent_runtimes.pop(run.run_id, None)
            self._turn_states.pop(run.session_id, None)

    def agent_run(self, run_id: str) -> AgentRun:
        try:
            run = self.library.load_agent_run(run_id)
        except ValueError as error:
            raise MarkerAgentNotFoundError("Agent 运行不存在") from error
        if run is None:
            raise MarkerAgentNotFoundError("Agent 运行不存在")
        state = self.session_state(run.session_id)
        if state.session.agent_type != MARKER_AGENT_TYPE:
            raise MarkerAgentNotFoundError("Agent 运行不存在")
        return run

    def agent_run_events(
        self, run_id: str, after_sequence: int = 0
    ) -> list[AgentEvent]:
        run = self.agent_run(run_id)
        return [
            event
            for event in self.library.load_agent_events(
                run.session_id, after_sequence=after_sequence
            )
            if event.run_id == run_id
        ]

    def cancel_agent_run(self, run_id: str) -> AgentRun:
        run = self.agent_run(run_id)
        if run.stage in {AgentRunStage.PENDING, AgentRunStage.RUNNING}:
            runtime = self._agent_runtimes.get(run_id)
            if runtime is not None:
                runtime.cancel(run_id)
        return run

    def accept_proposal(self, proposal_id: str) -> MarkerProposal:
        proposal = self._require_proposal(proposal_id)
        if proposal.status != MarkerProposalStatus.PENDING:
            return proposal
        current = self.library.load_markers(proposal.asset_id)
        current_by_id = {marker.marker_id: marker for marker in current}
        if any(
            current_by_id.get(snapshot.marker_id) != snapshot
            for change in proposal.changes
            for snapshot in change.before
        ):
            stale = proposal.model_copy(update={"status": MarkerProposalStatus.STALE})
            self.library.save_marker_proposal(stale)
            raise MarkerProposalConflictError("标记已发生变化，整批建议已过期")
        markers_by_id = dict(current_by_id)
        segments = self.library.load_segments(proposal.asset_id)
        for change in proposal.changes:
            source_ids = {marker.marker_id for marker in change.before}
            if change.operation in {
                MarkerProposalOperation.DELETE,
                MarkerProposalOperation.MERGE,
            }:
                for source_id in source_ids:
                    markers_by_id.pop(source_id, None)
            if change.operation == MarkerProposalOperation.UPDATE:
                markers_by_id.pop(change.before[0].marker_id, None)
            if change.after is not None:
                markers_by_id[change.after.marker_id] = change.after
            if source_ids:
                replacement_id = (
                    change.after.marker_id
                    if change.operation == MarkerProposalOperation.MERGE
                    and change.after
                    else None
                )
                segments = self._rewrite_segment_references(
                    segments, source_ids, replacement_id
                )
        resolved_markers = sorted(
            markers_by_id.values(), key=lambda marker: marker.start_seconds
        )
        self.library.replace_markers_and_segments(
            proposal.asset_id, resolved_markers, segments
        )
        accepted = proposal.model_copy(update={"status": MarkerProposalStatus.ACCEPTED})
        self.library.save_marker_proposal(accepted)
        return accepted

    def reject_proposal(self, proposal_id: str) -> MarkerProposal:
        proposal = self._require_proposal(proposal_id)
        if proposal.status != MarkerProposalStatus.PENDING:
            return proposal
        rejected = proposal.model_copy(update={"status": MarkerProposalStatus.REJECTED})
        self.library.save_marker_proposal(rejected)
        return rejected

    def _tool_registry(
        self,
        session_id: str,
        asset_id: str,
        retrieval_mode: MarkerRetrievalMode,
        model: AiModelConfiguration,
    ) -> AgentToolRegistry:
        registry = AgentToolRegistry()
        registry.register(
            AgentTool(
                name="search_transcript",
                description="搜索当前视频带时间戳的转录。",
                parameters_model=EvidenceSearchInput,
                handler=lambda parameters: self._search_transcript_for_turn(
                    session_id, asset_id, parameters
                ),
            )
        )
        registry.register(
            AgentTool(
                name="search_analysis",
                description="搜索当前视频已有的分析事件、OCR 和视觉描述。",
                parameters_model=EvidenceSearchInput,
                handler=lambda parameters: self._search_analysis_for_turn(
                    session_id, asset_id, parameters
                ),
            )
        )
        registry.register(
            AgentTool(
                name="read_markers",
                description="读取当前视频全部正式标记。",
                parameters_model=ReadMarkersInput,
                handler=lambda _: {
                    "ok": True,
                    "markers": [
                        marker.model_dump(mode="json")
                        for marker in self.library.load_markers(asset_id)
                    ],
                },
            )
        )
        registry.register(
            AgentTool(
                name="inspect_frames",
                description="抽取指定时间范围的代表画面并使用视觉模型回答问题。",
                parameters_model=InspectFramesInput,
                handler=lambda parameters: self._inspect_frames_for_turn(
                    session_id, asset_id, model, parameters
                ),
            )
        )
        registry.register(
            AgentTool(
                name="propose_marker_changes",
                description="创建一批待用户整体接受或拒绝的标记变更建议。",
                parameters_model=ProposeMarkerChangesInput,
                handler=lambda parameters: self._propose_changes(
                    session_id, asset_id, parameters
                ),
            )
        )
        return registry

    @staticmethod
    def _allowed_tools(mode: MarkerRetrievalMode) -> tuple[str, ...]:
        base = ("search_transcript", "read_markers", "propose_marker_changes")
        if mode == MarkerRetrievalMode.TRANSCRIPT:
            return base
        return (*base[:1], "search_analysis", base[1], "inspect_frames", base[2])

    def _search_transcript(
        self, asset_id: str, parameters: EvidenceSearchInput
    ) -> dict[str, object]:
        transcript = self.library.load_transcript(asset_id)
        segments = transcript.segments if transcript else []
        evidence = [
            {
                "start_seconds": segment.start_seconds,
                "end_seconds": segment.end_seconds,
                "text": segment.text,
            }
            for segment in segments
            if self._matches_evidence(
                segment.start_seconds, segment.end_seconds, segment.text, parameters
            )
        ][: parameters.limit]
        return {"ok": True, "evidence": evidence}

    def _search_transcript_for_turn(
        self,
        session_id: str,
        asset_id: str,
        parameters: EvidenceSearchInput,
    ) -> dict[str, object]:
        result = self._search_transcript(asset_id, parameters)
        if turn_state := self._turn_states.get(session_id):
            turn_state.text_searched = True
        return result

    def _search_analysis(
        self, asset_id: str, parameters: EvidenceSearchInput
    ) -> dict[str, object]:
        evidence = [
            {
                "segment_id": segment.segment_id,
                "start_seconds": segment.start_seconds,
                "end_seconds": segment.end_seconds,
                "title": segment.title,
                "visual_description": segment.visual_description,
                "ocr_text": segment.ocr_text,
                "summary": segment.detailed_summary,
            }
            for segment in self.library.load_segments(asset_id)
            if self._matches_evidence(
                segment.start_seconds,
                segment.end_seconds,
                "\n".join(
                    value
                    for value in (
                        segment.title,
                        segment.visual_description,
                        segment.ocr_text,
                        segment.detailed_summary,
                    )
                    if value
                ),
                parameters,
            )
        ][: parameters.limit]
        return {"ok": True, "evidence": evidence}

    def _search_analysis_for_turn(
        self,
        session_id: str,
        asset_id: str,
        parameters: EvidenceSearchInput,
    ) -> dict[str, object]:
        result = self._search_analysis(asset_id, parameters)
        if turn_state := self._turn_states.get(session_id):
            turn_state.text_searched = True
        return result

    @staticmethod
    def _matches_evidence(
        start_seconds: float,
        end_seconds: float,
        text: str,
        parameters: EvidenceSearchInput,
    ) -> bool:
        if (
            parameters.start_seconds is not None
            and end_seconds < parameters.start_seconds
        ):
            return False
        if (
            parameters.end_seconds is not None
            and start_seconds > parameters.end_seconds
        ):
            return False
        query = (parameters.query or "").casefold().strip()
        return not query or query in text.casefold()

    def _inspect_frames(
        self,
        asset_id: str,
        model: AiModelConfiguration,
        parameters: InspectFramesInput,
    ) -> dict[str, object]:
        if IMAGE_INPUT_MODALITY not in model.input_modalities:
            return {"ok": False, "error": "当前模型不支持图像输入"}
        asset = self._require_asset(asset_id)
        if (
            asset.duration_seconds is not None
            and parameters.end_seconds > asset.duration_seconds
        ):
            return {"ok": False, "error": "画面范围超出视频时长"}
        media_path = self.library.resolve_asset_file(asset, asset.playback_path)
        if media_path is None:
            return {"ok": False, "error": "视频文件不存在"}
        duration = parameters.end_seconds - parameters.start_seconds
        time_points = [
            parameters.start_seconds + duration * position
            for position in (0.15, 0.5, 0.85)
        ]
        temporary_directory = self.library.temporary_directory(f"job-{uuid7().hex}")
        try:
            frames = extract_frames(
                media_path,
                time_points,
                temporary_directory,
                self.settings.ffmpeg_path,
                self.settings.ffmpeg_bin_dir,
            )
            description = LiteLlmVision(model).describe(frames, parameters.question)
        finally:
            shutil.rmtree(temporary_directory, ignore_errors=True)
        return {
            "ok": True,
            "start_seconds": parameters.start_seconds,
            "end_seconds": parameters.end_seconds,
            "description": description,
        }

    def _inspect_frames_for_turn(
        self,
        session_id: str,
        asset_id: str,
        model: AiModelConfiguration,
        parameters: InspectFramesInput,
    ) -> dict[str, object]:
        turn_state = self._turn_states.get(session_id)
        if (
            turn_state is not None
            and turn_state.retrieval_mode == MarkerRetrievalMode.AUTO
            and not turn_state.text_searched
        ):
            return {"ok": False, "error": "智能模式必须先检索转录或已有分析"}
        result = self._inspect_frames(asset_id, model, parameters)
        if result.get("ok") is True and turn_state is not None:
            turn_state.vision_inspected = True
        return result

    def _propose_changes(
        self,
        session_id: str,
        asset_id: str,
        parameters: ProposeMarkerChangesInput,
    ) -> dict[str, object]:
        turn_state = self._turn_states.get(session_id)
        if (
            turn_state is not None
            and turn_state.retrieval_mode == MarkerRetrievalMode.VISION
            and not turn_state.vision_inspected
        ):
            return {"ok": False, "error": "画面理解模式必须先检查相关画面"}
        asset = self._require_asset(asset_id)
        current = {
            marker.marker_id: marker for marker in self.library.load_markers(asset_id)
        }
        changes: list[MarkerProposalChange] = []
        referenced_marker_ids: set[str] = set()
        for requested in parameters.changes:
            marker_ids = requested.marker_ids
            if len(marker_ids) != len(set(marker_ids)):
                return {"ok": False, "error": "同一操作不能重复引用标记"}
            if referenced_marker_ids.intersection(marker_ids):
                return {"ok": False, "error": "同一批建议不能重复修改标记"}
            referenced_marker_ids.update(marker_ids)
            before = [
                current[marker_id] for marker_id in marker_ids if marker_id in current
            ]
            expected_count = {
                MarkerProposalOperation.CREATE: 0,
                MarkerProposalOperation.UPDATE: 1,
                MarkerProposalOperation.DELETE: 1,
                MarkerProposalOperation.MERGE: 2,
            }[requested.operation]
            if requested.operation == MarkerProposalOperation.MERGE:
                if len(before) < expected_count or len(before) != len(marker_ids):
                    return {"ok": False, "error": "合并操作至少需要两个现有标记"}
            elif len(before) != expected_count or len(before) != len(marker_ids):
                return {"ok": False, "error": "建议引用的标记不存在或数量无效"}
            after = self._proposed_after(asset_id, requested, before)
            if after is not None:
                self._validate_marker(after, asset.duration_seconds)
            changes.append(
                MarkerProposalChange(
                    operation=requested.operation,
                    before=before,
                    after=after,
                    reason=requested.reason,
                    evidence=requested.evidence,
                )
            )
        proposal = MarkerProposal(
            proposal_id=f"proposal-{uuid7().hex}",
            session_id=session_id,
            asset_id=asset_id,
            changes=changes,
        )
        self.library.save_marker_proposal(proposal)
        return {"ok": True, "proposal": proposal.model_dump(mode="json")}

    @staticmethod
    def _proposed_after(
        asset_id: str,
        requested: ProposedMarkerChangeInput,
        before: list[MediaMarker],
    ) -> MediaMarker | None:
        if requested.operation == MarkerProposalOperation.DELETE:
            return None
        if requested.start_seconds is None:
            raise MarkerAgentError("新增、修改或合并建议必须提供开始时间")
        marker_id = (
            before[0].marker_id
            if requested.operation == MarkerProposalOperation.UPDATE
            else f"marker-{uuid7().hex}"
        )
        return MediaMarker(
            marker_id=marker_id,
            asset_id=asset_id,
            start_seconds=requested.start_seconds,
            end_seconds=requested.end_seconds,
            title=requested.title,
            tags=requested.tags,
        )

    @staticmethod
    def _rewrite_segment_references(
        segments: list[MediaSegment],
        source_ids: set[str],
        replacement_id: str | None,
    ) -> list[MediaSegment]:
        rewritten: list[MediaSegment] = []
        for segment in segments:
            marker_ids = [
                marker_id
                for marker_id in segment.marker_ids
                if marker_id not in source_ids
            ]
            if replacement_id and any(
                marker_id in source_ids for marker_id in segment.marker_ids
            ):
                marker_ids.append(replacement_id)
            rewritten.append(
                segment.model_copy(
                    update={"marker_ids": list(dict.fromkeys(marker_ids))}
                )
            )
        return rewritten

    @staticmethod
    def _turn_retrieval_mode(
        selected: MarkerRetrievalMode, content: str
    ) -> MarkerRetrievalMode:
        normalized = content.casefold()
        if any(phrase in normalized for phrase in ("只看字幕", "只看转录", "仅转录")):
            return MarkerRetrievalMode.TRANSCRIPT
        if any(phrase in normalized for phrase in ("检查画面", "看画面", "画面理解")):
            return MarkerRetrievalMode.VISION
        return selected

    def _context(self, asset_id: str) -> str:
        asset = self._require_asset(asset_id)
        return (
            f"当前视频：{asset.title}\n"
            f"素材标识：{asset.asset_id}\n"
            f"时长：{asset.duration_seconds if asset.duration_seconds is not None else '未知'} 秒"
        )

    def _require_asset(self, asset_id: str):
        try:
            asset = self.library.get(asset_id)
        except ValueError as error:
            raise MarkerAgentNotFoundError("媒体资源不存在") from error
        if asset is None:
            raise MarkerAgentNotFoundError("媒体资源不存在")
        return asset

    def _require_proposal(self, proposal_id: str) -> MarkerProposal:
        try:
            proposal = self.library.load_marker_proposal(proposal_id)
        except ValueError as error:
            raise MarkerAgentNotFoundError("标记建议不存在") from error
        if proposal is None:
            raise MarkerAgentNotFoundError("标记建议不存在")
        return proposal

    @staticmethod
    def _validate_marker(marker: MediaMarker, duration_seconds: float | None) -> None:
        if duration_seconds is not None and (
            marker.start_seconds > duration_seconds
            or (
                marker.end_seconds is not None and marker.end_seconds > duration_seconds
            )
        ):
            raise MarkerAgentError("标记范围超出视频时长")
