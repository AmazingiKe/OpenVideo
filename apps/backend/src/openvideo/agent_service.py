"""声明式注册三个用途，并通过同一服务管理会话、运行与审批。"""

from __future__ import annotations

import asyncio
import shutil
from datetime import UTC, datetime
from typing import Any, Protocol

from openvideo.agent_runtime import (
    AgentRuntime,
    AgentSessionStore,
    AgentTool,
    AgentToolRegistry,
    new_agent_run,
)
from openvideo.agent_registry import (
    AgentConflictError,
    AgentDefinitionRegistry,
    AgentNotFoundError,
    AgentServiceError,
    RegisteredAgent,
    agent_availability,
    build_run_content,
    validate_model,
)
from openvideo.agent_tooling import (
    AgentRunContext,
    CorrectTranscriptInput,
    EvidenceSearchInput,
    InspectFramesInput,
    MarkerChangeOperation,
    ProposeMarkerChangesInput,
    ProposeSummaryEditInput,
    ReadMarkersInput,
    ReadSummaryDocumentInput,
    build_proposed_marker,
    markdown_diff,
    marker_digest,
    ranges_intersect,
    rewrite_segment_references,
    transcript_digest,
    validate_marker_bounds,
)
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentArtifactStatus,
    AgentCapability,
    AgentDefinition,
    AgentDefinitionAvailability,
    AgentEvent,
    AgentEventType,
    AgentMode,
    AgentRun,
    AgentRunCreate,
    AgentSession,
    AgentSessionCreate,
    AgentSessionState,
    AgentToolDescriptor,
    TERMINAL_AGENT_RUN_STAGES,
)
from openvideo.core.ai_models import IMAGE_INPUT_MODALITY, AiModelConfiguration
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaMarker
from openvideo.core.summary_models import (
    SummaryDocumentCreate,
    SummaryDocumentUpdate,
)
from openvideo.settings import Settings
from openvideo.tools.frames import extract_frames
from openvideo.tools.transcript_correction import LiteLlmTranscriptCorrector
from openvideo.tools.vision import LiteLlmVision
from openvideo.llm.agno_executor import AgnoAgentExecutor
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.llm.model_profile import CapabilityName, ModelProfile, Support


MARKER_AGENT_ID = "marker"
SUMMARY_AGENT_ID = "summary"
TRANSCRIPT_CORRECTION_AGENT_ID = "transcript_correction"
MARKER_ARTIFACT_TYPE = "marker_changes"
SUMMARY_ARTIFACT_TYPE = "summary_edit"
TRANSCRIPT_ARTIFACT_TYPE = "transcript_correction"
SESSION_TITLE_LENGTH = 60
AGENT_RUN_INTENT_KEY = "intent"
AGENT_RUN_EDIT_INTENT = "edit"
MARKER_EVIDENCE_TOOL_NAMES = frozenset({"search_evidence", "inspect_frames"})






class SummaryDocumentService(Protocol):
    def update_document(
        self, document_id: str, request: SummaryDocumentUpdate
    ) -> Any: ...

    def create_child(
        self, root_document_id: str, request: SummaryDocumentCreate
    ) -> Any: ...








class AgentService:
    def __init__(
        self,
        library: MediaLibrary,
        settings: Settings,
        summary_documents: SummaryDocumentService,
        capability_resolver: CapabilityResolver | None = None,
    ) -> None:
        self.library = library
        self.settings = settings
        self.summary_documents = summary_documents
        self.capability_resolver = capability_resolver or CapabilityResolver()
        self.store = AgentSessionStore(library)
        self._tasks: dict[str, asyncio.Task[AgentRun]] = {}
        self._runtimes: dict[str, AgentRuntime] = {}
        self.registry = AgentDefinitionRegistry(self._registered_agents())
        self.library.interrupt_agent_runs()

    def definitions(self) -> list[AgentDefinitionAvailability]:
        models = self.settings.ai_models
        return [
            agent_availability(
                registered.definition, models, self.capability_resolver
            )
            for registered in self.registry.values()
        ]

    def sessions(
        self, *, agent_id: str | None = None, asset_id: str | None = None
    ) -> list[AgentSession]:
        if agent_id is not None:
            self.registry.require(agent_id)
        return self.library.load_agent_sessions(agent_id=agent_id, asset_id=asset_id)

    def create_session(self, request: AgentSessionCreate) -> AgentSession:
        registered = self.registry.require(request.agent_id)
        if self.library.get(request.asset_id) is None:
            raise AgentNotFoundError("媒体资源不存在")
        context = dict(request.context)
        if registered.session_validator is not None:
            registered.session_validator(request.asset_id, context)
        title = request.title or registered.definition.title
        session = AgentSession(
            session_id=f"session-{uuid7().hex}",
            agent_id=request.agent_id,
            asset_id=request.asset_id,
            title=title,
            context=context,
        )
        self.library.save_agent_session(session)
        return session

    def session_state(self, session_id: str) -> AgentSessionState:
        session = self._require_session(session_id)
        return AgentSessionState(
            session=session,
            runs=self.library.load_agent_runs(session_id),
            events=self.library.load_agent_events(session_id),
            artifacts=self.library.load_agent_artifacts(session_id=session_id),
        )

    def create_run(self, session_id: str, request: AgentRunCreate) -> AgentRun:
        session = self._require_session(session_id)
        registered = self.registry.require(session.agent_id)
        existing = self.library.load_agent_run_by_request_key(request.request_key)
        if existing is not None:
            if existing.session_id != session_id:
                raise AgentConflictError("请求键已被其他会话使用")
            return existing
        if any(
            run.stage not in TERMINAL_AGENT_RUN_STAGES
            for run in self.library.load_agent_runs(session_id)
        ):
            raise AgentConflictError("当前会话已有正在运行的任务")
        model = self.settings.ai_model(request.ai_model_id)
        if model is None:
            raise AgentServiceError("所选 AI 模型不存在", "model_not_found")
        profile = self.capability_resolver.resolve(model)
        definition = (
            registered.run_definition(registered.definition, request, profile)
            if registered.run_definition is not None
            else registered.definition
        )
        validate_model(definition, profile)
        content = build_run_content(definition, request)
        run = new_agent_run(session_id, request.request_key, request.ai_model_id)
        context = AgentRunContext(self, session, run, model, request.task_input)
        tool_registry = registered.tool_builder(context, definition)
        tool_registry.validate(definition.allowed_tools)
        self.library.save_agent_run(run)
        if not self.library.load_agent_events(session_id):
            self.library.save_agent_session(
                session.model_copy(
                    update={
                        "title": content.splitlines()[0][:SESSION_TITLE_LENGTH]
                        or registered.definition.title,
                        "updated_at": datetime.now(UTC),
                    }
                )
            )
        runtime = AgentRuntime(self.store, tool_registry, AgnoAgentExecutor())
        self._runtimes[run.run_id] = runtime
        task = asyncio.create_task(
            runtime.run(run, model, profile, definition, content)
        )
        self._tasks[run.run_id] = task
        task.add_done_callback(
            lambda completed_task: self._complete_run(run.run_id, model, completed_task)
        )
        return run

    def run(self, run_id: str) -> AgentRun:
        try:
            run = self.library.load_agent_run(run_id)
        except ValueError as error:
            raise AgentNotFoundError("Agent 运行不存在") from error
        if run is None:
            raise AgentNotFoundError("Agent 运行不存在")
        return run

    def run_events(self, run_id: str, after_sequence: int = 0) -> list[AgentEvent]:
        run = self.run(run_id)
        return [
            event
            for event in self.library.load_agent_events(
                run.session_id, after_sequence=after_sequence
            )
            if event.run_id == run_id
        ]

    async def cancel(self, run_id: str) -> AgentRun:
        run = self.run(run_id)
        if run.stage in TERMINAL_AGENT_RUN_STAGES:
            return run
        if runtime := self._runtimes.get(run_id):
            runtime.cancel(run_id)
        if task := self._tasks.get(run_id):
            await asyncio.gather(task, return_exceptions=True)
        return self.run(run_id)

    def approve(self, artifact_id: str) -> AgentArtifact:
        artifact = self._require_artifact(artifact_id)
        if artifact.status != AgentArtifactStatus.PENDING:
            return artifact
        registered = self.registry.require(artifact.agent_id)
        try:
            registered.approver(artifact)
        except AgentConflictError as error:
            stale = artifact.model_copy(
                update={
                    "status": AgentArtifactStatus.STALE,
                    "error_message": str(error),
                    "updated_at": datetime.now(UTC),
                }
            )
            self.library.save_agent_artifact(stale)
            raise
        approved = artifact.model_copy(
            update={
                "status": AgentArtifactStatus.APPROVED,
                "updated_at": datetime.now(UTC),
            }
        )
        self.library.save_agent_artifact(approved)
        return approved

    def reject(self, artifact_id: str) -> AgentArtifact:
        artifact = self._require_artifact(artifact_id)
        if artifact.status != AgentArtifactStatus.PENDING:
            return artifact
        rejected = artifact.model_copy(
            update={
                "status": AgentArtifactStatus.REJECTED,
                "updated_at": datetime.now(UTC),
            }
        )
        self.library.save_agent_artifact(rejected)
        return rejected

    async def close(self) -> None:
        for runtime_id, runtime in list(self._runtimes.items()):
            runtime.cancel(runtime_id)
        if self._tasks:
            await asyncio.gather(*self._tasks.values(), return_exceptions=True)

    def has_active_jobs(self) -> bool:
        return any(not task.done() for task in self._tasks.values())

    async def cancel_assets(self, asset_ids: set[str]) -> bool:
        targets = [
            run.run_id
            for session in self.library.load_agent_sessions()
            if session.asset_id in asset_ids
            for run in self.library.load_agent_runs(session.session_id)
            if run.stage not in TERMINAL_AGENT_RUN_STAGES
        ]
        await asyncio.gather(*(self.cancel(run_id) for run_id in targets))
        return all(run_id not in self._tasks for run_id in targets)

    def _discard_run(self, run_id: str) -> None:
        self._tasks.pop(run_id, None)
        self._runtimes.pop(run_id, None)

    def _complete_run(
        self,
        run_id: str,
        model: AiModelConfiguration,
        _task: asyncio.Task[AgentRun],
    ) -> None:
        run = self.library.load_agent_run(run_id)
        if run is not None and any(
            event.event_type == AgentEventType.TOOL_STATUS
            and event.payload.get("stage") == "completed"
            for event in self.run_events(run_id)
        ):
            self.capability_resolver.record_probe(
                model,
                {
                    CapabilityName.TOOLS: Support.YES,
                    CapabilityName.STREAMING_TOOLS: Support.YES,
                    CapabilityName.TOOL_CHOICE_AUTO: Support.YES,
                },
            )
        self._discard_run(run_id)

    def _registered_agents(self) -> list[RegisteredAgent]:
        marker = AgentDefinition(
            agent_id=MARKER_AGENT_ID,
            title="标记 Agent",
            description="围绕视频证据回答问题，或生成整批标记变更预览。",
            mode=AgentMode.CHAT,
            prompt=(
                "你是 OpenVideo 视频内容与标记协作 Agent。"
                "当前运行配置会明确指定内容问答或生成标记建议；严格遵守配置，"
                "不要在正文叙述计划、搜索步骤、工具选择或内部推理。"
            ),
            required_capabilities={AgentCapability.TOOLS},
            tools=[
                AgentToolDescriptor(name="read_markers", description="读取现有标记"),
                AgentToolDescriptor(
                    name="search_evidence", description="搜索转录与分析证据"
                ),
                AgentToolDescriptor(
                    name="inspect_frames", description="检查指定时间范围画面"
                ),
                AgentToolDescriptor(
                    name="propose_marker_changes",
                    description="生成整批标记变更审批预览",
                    prerequisites=["read_markers", "search_evidence"],
                ),
            ],
            result_type=MARKER_ARTIFACT_TYPE,
        )
        summary = AgentDefinition(
            agent_id=SUMMARY_AGENT_ID,
            title="总结 Agent",
            description="围绕视频证据问答，或生成总结文档修改预览。",
            mode=AgentMode.CHAT,
            prompt=(
                "你是 OpenVideo 总结协作 Agent。正常回答问答；用户明确要求编辑时，先读取文档，"
                "再通过 propose_summary_edit 生成待审批结果。"
            ),
            tools=[
                AgentToolDescriptor(name="search_evidence", description="搜索视频证据"),
                AgentToolDescriptor(
                    name="read_summary_document", description="读取总结文档"
                ),
                AgentToolDescriptor(
                    name="propose_summary_edit",
                    description="生成总结修改审批预览",
                    prerequisites=["read_summary_document"],
                ),
            ],
            result_type=SUMMARY_ARTIFACT_TYPE,
        )
        correction = AgentDefinition(
            agent_id=TRANSCRIPT_CORRECTION_AGENT_ID,
            title="字幕纠错",
            description="校对指定字幕片段并生成逐项修改预览。",
            mode=AgentMode.TASK,
            input_mode="task",
            prompt=(
                "你是 OpenVideo 字幕纠错 Agent。必须调用 correct_transcript 完成任务，"
                "只修正识别错误，不改变时间边界。"
            ),
            required_capabilities={AgentCapability.TOOLS, AgentCapability.LONG_CONTEXT},
            minimum_context_tokens=16_000,
            tools=[
                AgentToolDescriptor(
                    name="correct_transcript", description="校对指定字幕片段"
                )
            ],
            required_tools={"correct_transcript"},
            requires_approval=True,
            result_type=TRANSCRIPT_ARTIFACT_TYPE,
        )
        return [
            RegisteredAgent(
                marker,
                self._marker_tools,
                self._approve_marker_changes,
                None,
                self._marker_run_definition,
            ),
            RegisteredAgent(
                summary,
                self._summary_tools,
                self._approve_summary_edit,
                self._validate_summary_session,
                self._summary_run_definition,
            ),
            RegisteredAgent(
                correction,
                self._transcript_tools,
                self._approve_transcript_correction,
                None,
                None,
            ),
        ]

    def _validate_summary_session(self, asset_id: str, context: dict[str, Any]) -> None:
        document_id = context.get("document_id")
        document = (
            self.library.load_summary_document(str(document_id))
            if document_id
            else None
        )
        if document is None or document.asset_id != asset_id:
            raise AgentServiceError("总结 Agent 必须绑定当前素材的一篇文档")

    def _summary_run_definition(
        self,
        definition: AgentDefinition,
        request: AgentRunCreate,
        profile: ModelProfile,
    ) -> AgentDefinition:
        edit_intent = (
            request.task_input.get(AGENT_RUN_INTENT_KEY) == AGENT_RUN_EDIT_INTENT
        )
        if edit_intent:
            return definition.model_copy(
                update={
                    "required_capabilities": {AgentCapability.TOOLS},
                    "required_tools": {"propose_summary_edit"},
                    "requires_approval": True,
                }
            )
        if profile.support(CapabilityName.TOOLS) != Support.NO:
            return definition
        return definition.model_copy(update={"tools": []})

    @staticmethod
    def _marker_run_definition(
        definition: AgentDefinition,
        request: AgentRunCreate,
        _profile: ModelProfile,
    ) -> AgentDefinition:
        edit_intent = (
            request.task_input.get(AGENT_RUN_INTENT_KEY) == AGENT_RUN_EDIT_INTENT
        )
        if edit_intent:
            return definition.model_copy(
                update={
                    "prompt": (
                        "你是 OpenVideo 标记 Agent。当前运行只生成标记变更预览。"
                        "先读取现有标记并检索相关时间范围证据，必要时检查画面。"
                        "你只能建议时间边界，不能设置或修改用户的重要程度。"
                        "取得证据后必须调用 propose_marker_changes 生成整批待审批结果，"
                        "调用成功前不得结束运行，也不得声称建议已经执行。"
                        "不要在正文叙述计划、搜索步骤、工具选择或内部推理。"
                    ),
                    "required_tools": {"propose_marker_changes"},
                    "requires_approval": True,
                }
            )
        evidence_tools = [
            tool for tool in definition.tools if tool.name in MARKER_EVIDENCE_TOOL_NAMES
        ]
        return definition.model_copy(
            update={
                "prompt": (
                    "你是 OpenVideo 视频内容问答 Agent。当前运行只回答用户的问题。"
                    "必须先调用 search_evidence 检索当前视频的转录与分析证据；"
                    "回答全片主题、课程内容或整体结构时不要传 query，避免把概览问题误当作关键词过滤；"
                    "只有问题确实依赖画面时才调用 inspect_frames。"
                    "根据取得的证据直接、明确地回答；证据不足时说明缺少什么。"
                    "正文第一句必须直接给出结论，禁止使用‘我来’、‘让我’、‘正在’或‘先’来叙述过程。"
                    "不要创建、提交或声称创建了标记建议，也不要讨论内部工具步骤。"
                ),
                "tools": evidence_tools,
                "required_tools": {"search_evidence"},
                "requires_approval": False,
            }
        )


    def _marker_tools(
        self, context: AgentRunContext, definition: AgentDefinition
    ) -> AgentToolRegistry:
        registry = AgentToolRegistry()
        registry.register(
            AgentTool(
                "read_markers",
                "读取当前视频全部正式标记。",
                ReadMarkersInput,
                lambda _: self._read_markers(context),
            )
        )
        registry.register(
            AgentTool(
                "search_evidence",
                "搜索带时间戳的转录、分析、OCR 与视觉描述。",
                EvidenceSearchInput,
                lambda parameters: self._search_evidence(context, parameters),
            )
        )
        registry.register(
            AgentTool(
                "inspect_frames",
                "抽取指定时间范围的自适应代表画面并回答问题。",
                InspectFramesInput,
                lambda parameters: self._inspect_frames(context, parameters),
                prerequisite=lambda: (
                    context.evidence.evidence_read,
                    "检查画面前必须先搜索转录或已有分析",
                ),
            )
        )
        registry.register(
            AgentTool(
                "propose_marker_changes",
                "创建一批待整体接受或拒绝的标记变更预览。",
                ProposeMarkerChangesInput,
                lambda parameters: self._propose_marker_changes(context, parameters),
                prerequisite=lambda: (
                    context.evidence.markers_read and context.evidence.evidence_read,
                    "生成标记建议前必须读取现有标记和相关时间范围证据",
                ),
            )
        )
        return registry

    def _summary_tools(
        self, context: AgentRunContext, definition: AgentDefinition
    ) -> AgentToolRegistry:
        registry = AgentToolRegistry()
        if "search_evidence" in definition.allowed_tools:
            registry.register(
                AgentTool(
                    "search_evidence",
                    "搜索带时间戳的转录和分析证据。",
                    EvidenceSearchInput,
                    lambda parameters: self._search_evidence(context, parameters),
                )
            )
        if "read_summary_document" in definition.allowed_tools:
            registry.register(
                AgentTool(
                    "read_summary_document",
                    "读取当前视频的一篇总结文档。",
                    ReadSummaryDocumentInput,
                    lambda parameters: self._read_summary(context, parameters),
                )
            )
        if "propose_summary_edit" in definition.allowed_tools:
            registry.register(
                AgentTool(
                    "propose_summary_edit",
                    "创建总结文档修改预览。",
                    ProposeSummaryEditInput,
                    lambda parameters: self._propose_summary_edit(context, parameters),
                )
            )
        return registry

    def _transcript_tools(
        self, context: AgentRunContext, definition: AgentDefinition
    ) -> AgentToolRegistry:
        registry = AgentToolRegistry()
        registry.register(
            AgentTool(
                "correct_transcript",
                "校对指定字幕片段并生成修改预览。",
                CorrectTranscriptInput,
                lambda parameters: self._correct_transcript(context, parameters),
            )
        )
        return registry

    def _read_markers(self, context: AgentRunContext) -> dict[str, Any]:
        context.evidence.markers_read = True
        return {
            "ok": True,
            "markers": [
                marker.model_dump(mode="json")
                for marker in self.library.load_markers(context.session.asset_id)
            ],
        }

    def _search_evidence(
        self, context: AgentRunContext, parameters: EvidenceSearchInput
    ) -> dict[str, Any]:
        query = (parameters.query or "").casefold().strip()
        evidence: list[dict[str, Any]] = []
        transcript = self.library.load_transcript(context.session.asset_id)
        for segment in transcript.segments if transcript else []:
            if not ranges_intersect(
                segment.start_seconds,
                segment.end_seconds,
                parameters.start_seconds,
                parameters.end_seconds,
            ) or (query and query not in segment.text.casefold()):
                continue
            evidence.append(
                {
                    "source": "transcript",
                    "start_seconds": segment.start_seconds,
                    "end_seconds": segment.end_seconds,
                    "text": segment.text,
                }
            )
            if len(evidence) >= parameters.limit:
                break
        for segment in self.library.load_segments(context.session.asset_id):
            if len(evidence) >= parameters.limit:
                break
            text = "\n".join(
                value
                for value in (
                    segment.title,
                    segment.detailed_summary,
                    segment.transcript_text,
                    segment.visual_description,
                    segment.ocr_text,
                )
                if value
            )
            if not ranges_intersect(
                segment.start_seconds,
                segment.end_seconds,
                parameters.start_seconds,
                parameters.end_seconds,
            ) or (query and query not in text.casefold()):
                continue
            evidence.append(
                {
                    "source": "analysis",
                    "start_seconds": segment.start_seconds,
                    "end_seconds": segment.end_seconds,
                    "title": segment.title,
                    "text": text,
                }
            )
        context.evidence.evidence_read = True
        return {"ok": True, "evidence": evidence}

    async def _inspect_frames(
        self, context: AgentRunContext, parameters: InspectFramesInput
    ) -> dict[str, Any]:
        if IMAGE_INPUT_MODALITY not in context.model.input_modalities:
            return {
                "ok": False,
                "error_code": "vision_unavailable",
                "error": "当前模型不支持图像输入",
            }
        result = await asyncio.to_thread(self._inspect_frames_sync, context, parameters)
        if result.get("ok") is True:
            context.evidence.frames_inspected = True
        return result

    def _inspect_frames_sync(
        self, context: AgentRunContext, parameters: InspectFramesInput
    ) -> dict[str, Any]:
        asset = self.library.get(context.session.asset_id)
        if asset is None:
            return {"ok": False, "error": "媒体资源不存在"}
        if (
            asset.duration_seconds is not None
            and parameters.end_seconds > asset.duration_seconds
        ):
            return {"ok": False, "error": "画面范围超出视频时长"}
        media_path = self.library.resolve_asset_file(asset, asset.playback_path)
        if media_path is None:
            return {"ok": False, "error": "视频文件不存在"}
        duration = parameters.end_seconds - parameters.start_seconds
        frame_count = max(3, min(12, round(duration / 20) + 2))
        points = [
            parameters.start_seconds + duration * (index + 0.5) / frame_count
            for index in range(frame_count)
        ]
        temporary_directory = self.library.temporary_directory(
            f"agent-frame-{uuid7().hex}"
        )
        try:
            frames = extract_frames(
                media_path,
                points,
                temporary_directory,
                self.settings.ffmpeg_path,
                self.settings.ffmpeg_bin_dir,
            )
            description = LiteLlmVision(context.model).describe(
                frames, parameters.question
            )
        finally:
            shutil.rmtree(temporary_directory, ignore_errors=True)
        return {"ok": True, "description": description, "time_points": points}

    def _propose_marker_changes(
        self, context: AgentRunContext, parameters: ProposeMarkerChangesInput
    ) -> dict[str, Any]:
        current = {
            marker.marker_id: marker
            for marker in self.library.load_markers(context.session.asset_id)
        }
        asset = self.library.get(context.session.asset_id)
        assert asset is not None
        changes: list[dict[str, Any]] = []
        referenced: set[str] = set()
        for requested in parameters.changes:
            marker_ids = requested.marker_ids
            if len(marker_ids) != len(set(marker_ids)) or referenced.intersection(
                marker_ids
            ):
                return {"ok": False, "error": "同一批建议不能重复引用标记"}
            referenced.update(marker_ids)
            before = [current[item] for item in marker_ids if item in current]
            expected = {
                MarkerChangeOperation.CREATE: 0,
                MarkerChangeOperation.UPDATE: 1,
                MarkerChangeOperation.DELETE: 1,
                MarkerChangeOperation.MERGE: 2,
            }[requested.operation]
            if requested.operation == MarkerChangeOperation.MERGE:
                valid = len(before) >= expected and len(before) == len(marker_ids)
            else:
                valid = len(before) == expected and len(before) == len(marker_ids)
            if not valid:
                return {"ok": False, "error": "建议引用的标记不存在或数量无效"}
            after = build_proposed_marker(
                context.session.asset_id, requested, before
            )
            if after is not None:
                validate_marker_bounds(after, asset.duration_seconds)
            changes.append(
                {
                    "operation": requested.operation.value,
                    "before": [item.model_dump(mode="json") for item in before],
                    "after": after.model_dump(mode="json") if after else None,
                    "reason": requested.reason,
                    "evidence": requested.evidence,
                }
            )
        artifact = context.create_artifact(
            MARKER_ARTIFACT_TYPE,
            {
                "changes": changes,
                "snapshot_digest": marker_digest(list(current.values())),
            },
        )
        return {"ok": True, "artifact": artifact.model_dump(mode="json")}

    def _read_summary(
        self, context: AgentRunContext, parameters: ReadSummaryDocumentInput
    ) -> dict[str, Any]:
        document = self.library.load_summary_document(parameters.document_id)
        if document is None or document.asset_id != context.session.asset_id:
            return {"ok": False, "error": "文档不存在或不属于当前视频"}
        context.evidence.evidence_read = True
        return {"ok": True, "document": document.model_dump(mode="json")}

    def _propose_summary_edit(
        self, context: AgentRunContext, parameters: ProposeSummaryEditInput
    ) -> dict[str, Any]:
        document = self.library.load_summary_document(parameters.document_id)
        if document is None or document.asset_id != context.session.asset_id:
            return {"ok": False, "error": "文档不存在或不属于当前视频"}
        if document.revision != parameters.expected_revision:
            return {
                "ok": False,
                "error_code": "revision_conflict",
                "error": "文档版本冲突",
                "current_revision": document.revision,
            }
        if (
            document.markdown == parameters.proposed_markdown
            and not parameters.suggested_subdocuments
        ):
            return {"ok": False, "error": "建议没有包含任何实际变化"}
        artifact = context.create_artifact(
            SUMMARY_ARTIFACT_TYPE,
            {
                "document_id": document.document_id,
                "base_revision": document.revision,
                "original_markdown": document.markdown,
                "proposed_markdown": parameters.proposed_markdown,
                "explanation": parameters.explanation,
                "diff": markdown_diff(document.markdown, parameters.proposed_markdown),
                "suggested_subdocuments": [
                    item.model_dump(mode="json")
                    for item in parameters.suggested_subdocuments
                ],
            },
        )
        return {"ok": True, "artifact": artifact.model_dump(mode="json")}

    async def _correct_transcript(
        self, context: AgentRunContext, parameters: CorrectTranscriptInput
    ) -> dict[str, Any]:
        transcript = self.library.load_transcript(context.session.asset_id)
        if transcript is None or not transcript.segments:
            return {"ok": False, "error": "当前视频没有可纠错的字幕"}
        indices = parameters.segment_indices
        if indices is None:
            task_indices = context.task_input.get("segment_indices")
            indices = task_indices if isinstance(task_indices, list) else None
        resolved = (
            list(range(len(transcript.segments)))
            if indices is None
            else list(dict.fromkeys(indices))
        )
        if not resolved or any(
            index < 0 or index >= len(transcript.segments) for index in resolved
        ):
            return {"ok": False, "error": "字幕片段范围无效"}
        corrector = LiteLlmTranscriptCorrector(context.model)
        method = {
            "automatic": corrector.correct,
            "chunked": corrector.correct_chunked,
            "compressed": corrector.correct_with_compressed_context,
        }[parameters.execution_mode]
        corrections = await asyncio.to_thread(method, transcript, resolved)
        changes = [
            {
                "segment_index": index,
                "start_seconds": transcript.segments[index].start_seconds,
                "end_seconds": transcript.segments[index].end_seconds,
                "before": transcript.segments[index].text,
                "after": text,
            }
            for index, text in sorted(corrections.items())
        ]
        artifact = context.create_artifact(
            TRANSCRIPT_ARTIFACT_TYPE,
            {
                "transcript_digest": transcript_digest(transcript),
                "changes": changes,
            },
        )
        return {"ok": True, "artifact": artifact.model_dump(mode="json")}

    def _approve_marker_changes(self, artifact: AgentArtifact) -> None:
        current = self.library.load_markers(artifact.asset_id)
        if marker_digest(current) != artifact.payload["snapshot_digest"]:
            raise AgentConflictError("标记已发生变化，整批建议已过期")
        markers_by_id = {marker.marker_id: marker for marker in current}
        segments = self.library.load_segments(artifact.asset_id)
        for change in artifact.payload["changes"]:
            before = [MediaMarker.model_validate(item) for item in change["before"]]
            source_ids = {item.marker_id for item in before}
            operation = MarkerChangeOperation(change["operation"])
            after = (
                MediaMarker.model_validate(change["after"]) if change["after"] else None
            )
            if operation in {MarkerChangeOperation.DELETE, MarkerChangeOperation.MERGE}:
                for marker_id in source_ids:
                    markers_by_id.pop(marker_id, None)
            if operation == MarkerChangeOperation.UPDATE:
                markers_by_id.pop(before[0].marker_id, None)
            if after is not None:
                markers_by_id[after.marker_id] = after
            replacement = (
                after.marker_id
                if operation == MarkerChangeOperation.MERGE and after
                else None
            )
            segments = rewrite_segment_references(
                segments, source_ids, replacement
            )
        resolved = sorted(markers_by_id.values(), key=lambda item: item.start_seconds)
        self.library.replace_markers_and_segments(artifact.asset_id, resolved, segments)

    def _approve_summary_edit(self, artifact: AgentArtifact) -> None:
        payload = artifact.payload
        document = self.library.load_summary_document(payload["document_id"])
        if document is None or document.revision != payload["base_revision"]:
            raise AgentConflictError("总结文档已发生变化，建议已过期")
        updated = self.summary_documents.update_document(
            document.document_id,
            SummaryDocumentUpdate(
                expected_revision=document.revision,
                markdown=payload["proposed_markdown"],
            ),
        )
        root_id = (
            updated.document_id
            if updated.parent_document_id is None
            else updated.parent_document_id
        )
        for child in payload["suggested_subdocuments"]:
            self.summary_documents.create_child(
                root_id, SummaryDocumentCreate.model_validate(child)
            )

    def _approve_transcript_correction(self, artifact: AgentArtifact) -> None:
        transcript = self.library.load_transcript(artifact.asset_id)
        if (
            transcript is None
            or transcript_digest(transcript) != artifact.payload["transcript_digest"]
        ):
            raise AgentConflictError("字幕已发生变化，纠错预览已过期")
        segments = list(transcript.segments)
        for change in artifact.payload["changes"]:
            index = int(change["segment_index"])
            if segments[index].text != change["before"]:
                raise AgentConflictError("字幕片段已发生变化，纠错预览已过期")
            segments[index] = segments[index].model_copy(
                update={"text": change["after"]}
            )
        self.library.save_transcript(
            transcript.model_copy(update={"segments": segments})
        )

    def _require_session(self, session_id: str) -> AgentSession:
        try:
            session = self.library.load_agent_session(session_id)
        except ValueError as error:
            raise AgentNotFoundError("Agent 会话不存在") from error
        if session is None:
            raise AgentNotFoundError("Agent 会话不存在")
        return session

    def _require_artifact(self, artifact_id: str) -> AgentArtifact:
        try:
            artifact = self.library.load_agent_artifact(artifact_id)
        except ValueError as error:
            raise AgentNotFoundError("Agent 审批结果不存在") from error
        if artifact is None:
            raise AgentNotFoundError("Agent 审批结果不存在")
        return artifact
