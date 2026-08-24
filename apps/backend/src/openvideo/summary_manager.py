from __future__ import annotations

import asyncio
import difflib
import io
import json
import re
import zipfile
from datetime import UTC, datetime
from pathlib import Path

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
    AgentEventType,
    AgentRun,
    AgentRunStage,
    AgentSession,
)
from openvideo.core.transcription_models import TranscriptSegment
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAssetStatus, MediaSegment
from openvideo.core.summary_models import (
    SummaryAgentMessageRequest,
    SummaryAgentRun,
    SummaryAgentRunStage,
    SummaryAgentSession,
    SummaryAgentSessionState,
    SummaryConversation,
    SummaryAgentSessionCreate,
    SummaryConversationState,
    SummaryDocument,
    SummaryDocumentCreate,
    SummaryDocumentUpdate,
    SummaryEditProposal,
    SummaryExportResult,
    SummaryGenerationRequest,
    SummaryMediaArtifact,
    SummaryMediaCreate,
    SummaryMediaSuggestion,
    SummaryMediaType,
    SummaryMessage,
    SummaryMessageRole,
    SummaryProposalStatus,
)
from openvideo.core.summary_files import (
    SUMMARY_ASSETS_DIRECTORY_NAME,
    SUMMARY_DIRECTORY_NAME,
    SUMMARY_MANIFEST_FILE_NAME,
    SUMMARY_OUTPUT_DIRECTORY_NAME,
    atomic_write_bytes,
    atomic_write_text,
    build_manifest,
    document_relative_path,
    markdown_digest,
    resolve_summary_path,
    write_manifest,
)
from openvideo.settings import Settings
from openvideo.tools.llm import LiteLlmAgentAdapter, LlmCompletionError, complete_text
from openvideo.tools.summary_media import (
    GIF_DEFAULT_DURATION_SECONDS,
    SummaryMediaError,
    generate_summary_media,
)


SUMMARY_AGENT_TIMEOUT_SECONDS = 120
SUMMARY_AGENT_MAX_TOKENS = 12_000
SUMMARY_CONVERSATION_TITLE_LENGTH = 60
SUMMARY_CONVERSATION_CONTEXT_LIMIT = 12_000
SUMMARY_GENERATION_CONTEXT_LIMIT = 30_000
EXPORT_FILE_NAME_TIME_FORMAT = "%Y%m%d-%H%M%S-%f"
SUMMARY_AGENT_TYPE = "summary"
SUMMARY_AGENT_PERSONA = """你是 OpenVideo 的总结协作 Agent。
默认以自然语言正常回答用户的问题，必要时先搜索视频证据或读取总结文档。
提问、讨论、解释、评价或意图不明确时，不得调用 propose_summary_change。
只有用户明确要求修改文档，或明确确认此前修改方案时，才可调用 propose_summary_change。
修改工具只创建待审批建议，绝不声称已经修改文档。工具冲突或失败时应向用户解释。"""


class SearchVideoEvidenceInput(BaseModel):
    query: str | None = Field(default=None, max_length=500)
    start_seconds: float | None = Field(default=None, ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    limit: int = Field(default=12, ge=1, le=30)

    @model_validator(mode="after")
    def validate_range(self) -> "SearchVideoEvidenceInput":
        if (
            self.start_seconds is not None
            and self.end_seconds is not None
            and self.end_seconds <= self.start_seconds
        ):
            raise ValueError("结束时间必须晚于开始时间")
        return self


class ReadSummaryDocumentInput(BaseModel):
    document_id: str


class ProposedMediaSuggestion(BaseModel):
    media_type: SummaryMediaType
    start_seconds: float = Field(ge=0)
    end_seconds: float | None = Field(default=None, ge=0)
    insert_after: str | None = None
    caption: str = Field(min_length=1, max_length=500)


class ProposeSummaryChangeInput(BaseModel):
    proposed_markdown: str | None = None
    explanation: str = Field(min_length=1, max_length=4_000)
    suggested_subdocuments: list[SummaryDocumentCreate] = Field(default_factory=list)
    media_suggestions: list[ProposedMediaSuggestion] = Field(default_factory=list)


class SummaryError(RuntimeError):
    """总结工作台请求无法在当前资料库状态下完成。"""


class SummaryNotFoundError(SummaryError):
    """请求引用的总结资源不存在或不属于当前视频。"""


class SummaryRevisionConflictError(SummaryError):
    """文档已被更新，调用方必须读取新版本后再决定如何合并。"""


class SummaryManager:
    """集中维护总结项目的不变量、版本检查和长耗时 Agent 运行。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        self._tasks: set[asyncio.Task[None]] = set()
        self._agent_runtimes: dict[str, AgentRuntime] = {}
        self.library.interrupt_agent_runs()
        for asset in self.library.list():
            if self.library.load_summary_documents(asset.asset_id):
                self._documents(asset.asset_id)

    async def close(self) -> None:
        if not self._tasks:
            return
        await asyncio.gather(*self._tasks, return_exceptions=True)

    def has_active_jobs(self) -> bool:
        return any(not task.done() for task in self._tasks)

    def agent_sessions(self, asset_id: str) -> list[SummaryAgentSession]:
        self._require_asset(asset_id)
        sessions = self.library.load_summary_agent_sessions(asset_id)
        return [
            SummaryAgentSession(
                session=session,
                asset_id=asset_id,
                root_document_id=self.library.load_summary_agent_session_binding(
                    session.session_id
                )[1],
            )
            for session in sessions
        ]

    def create_agent_session(
        self, asset_id: str, request: SummaryAgentSessionCreate
    ) -> SummaryAgentSessionState:
        documents = self._documents(asset_id)
        document = next(
            (item for item in documents if item.document_id == request.document_id),
            None,
        )
        root = next(
            (item for item in documents if item.parent_document_id is None), None
        )
        if document is None or root is None:
            raise SummaryNotFoundError("总结文档不存在")
        session = AgentSession(
            session_id=f"session-{uuid7().hex}",
            agent_type=SUMMARY_AGENT_TYPE,
            title=document.title,
        )
        self.library.save_summary_agent_session(
            session, asset_id, root.document_id
        )
        return SummaryAgentSessionState(
            session=session,
            asset_id=asset_id,
            root_document_id=root.document_id,
        )

    def agent_session_state(self, session_id: str) -> SummaryAgentSessionState:
        try:
            session = self.library.load_agent_session(session_id)
            binding = self.library.load_summary_agent_session_binding(session_id)
        except ValueError as error:
            raise SummaryNotFoundError("总结 Agent 会话不存在") from error
        if session is None or binding is None or session.agent_type != SUMMARY_AGENT_TYPE:
            raise SummaryNotFoundError("总结 Agent 会话不存在")
        return SummaryAgentSessionState(
            session=session,
            asset_id=binding[0],
            root_document_id=binding[1],
            events=self.library.load_agent_events(session_id),
            proposals=self.library.load_agent_summary_proposals(session_id),
        )

    def delete_agent_session(self, session_id: str) -> None:
        state = self.agent_session_state(session_id)
        if len(self.library.load_summary_agent_sessions(state.asset_id)) <= 1:
            raise SummaryError("至少保留一个 Agent 会话")
        active_stages = {AgentRunStage.PENDING, AgentRunStage.RUNNING}
        if any(
            run.session_id == session_id and run.stage in active_stages
            for run in self.library.load_agent_runs()
        ):
            raise SummaryError("Agent 正在运行，暂时不能删除该会话")
        if not self.library.delete_agent_session(session_id):
            raise SummaryNotFoundError("总结 Agent 会话不存在")

    def create_agent_message(
        self, session_id: str, request: SummaryAgentMessageRequest
    ) -> AgentRun:
        state = self.agent_session_state(session_id)
        document = self._require_document(request.document_id)
        if document.asset_id != state.asset_id:
            raise SummaryNotFoundError("文档不属于该总结 Agent 会话")
        if document.revision != request.expected_revision:
            raise SummaryRevisionConflictError("文档版本已变化，请重新发送消息")
        model = self.settings.ai_model(request.ai_model_id)
        if model is None:
            raise SummaryError("所选 AI 模型不存在")
        content = request.content.strip()
        if not content:
            raise SummaryError("消息内容不能为空")
        if not state.events:
            session = state.session.model_copy(
                update={
                    "title": content.splitlines()[0][
                        :SUMMARY_CONVERSATION_TITLE_LENGTH
                    ],
                    "updated_at": datetime.now(UTC),
                }
            )
            self.library.save_agent_session(session)
        run = new_agent_run(session_id)
        self.library.save_agent_run(run)
        registry = self._summary_tool_registry(session_id, request, document)
        runtime = AgentRuntime(
            AgentSessionStore(self.library), registry, LiteLlmAgentAdapter()
        )
        self._agent_runtimes[run.run_id] = runtime
        preset = AgentPreset(
            persona=SUMMARY_AGENT_PERSONA,
            dynamic_context=lambda: self._summary_agent_context(request, document),
            allowed_tools=(
                "search_video_evidence",
                "read_summary_document",
                "propose_summary_change",
            ),
        )
        task = asyncio.create_task(
            self._execute_generic_agent_run(runtime, run, model, preset, content)
        )
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return run

    async def _execute_generic_agent_run(
        self,
        runtime: AgentRuntime,
        run: AgentRun,
        model,
        preset: AgentPreset,
        content: str,
    ) -> None:
        try:
            await runtime.run(run, model, preset, content)
        finally:
            self._agent_runtimes.pop(run.run_id, None)

    def generic_agent_run(self, run_id: str) -> AgentRun:
        try:
            run = self.library.load_agent_run(run_id)
        except ValueError as error:
            raise SummaryNotFoundError("Agent 运行不存在") from error
        if run is None:
            raise SummaryNotFoundError("Agent 运行不存在")
        return run

    def agent_run_events(
        self, run_id: str, after_sequence: int = 0
    ) -> list[AgentEvent]:
        run = self.generic_agent_run(run_id)
        return [
            event
            for event in self.library.load_agent_events(
                run.session_id, after_sequence=after_sequence
            )
            if event.run_id == run_id
        ]

    def cancel_agent_run(self, run_id: str) -> AgentRun:
        run = self.generic_agent_run(run_id)
        if run.stage not in {AgentRunStage.PENDING, AgentRunStage.RUNNING}:
            return run
        runtime = self._agent_runtimes.get(run_id)
        if runtime is not None:
            runtime.cancel(run_id)
        return run

    def _summary_tool_registry(
        self,
        session_id: str,
        request: SummaryAgentMessageRequest,
        document: SummaryDocument,
    ) -> AgentToolRegistry:
        registry = AgentToolRegistry()
        registry.register(
            AgentTool(
                name="search_video_evidence",
                description="按关键词或时间范围搜索当前视频的转录与分析证据。",
                parameters_model=SearchVideoEvidenceInput,
                handler=lambda parameters: self._search_video_evidence(
                    document.asset_id, parameters
                ),
            )
        )
        registry.register(
            AgentTool(
                name="read_summary_document",
                description="读取当前视频目录中的一篇总结文档。",
                parameters_model=ReadSummaryDocumentInput,
                handler=lambda parameters: self._read_summary_document(
                    document.asset_id, parameters
                ),
            )
        )
        registry.register(
            AgentTool(
                name="propose_summary_change",
                description="仅在用户明确要求修改时创建待用户审批的总结修改建议。",
                parameters_model=ProposeSummaryChangeInput,
                handler=lambda parameters: self._propose_summary_change(
                    session_id, request, document, parameters
                ),
            )
        )
        return registry

    def _search_video_evidence(
        self, asset_id: str, parameters: SearchVideoEvidenceInput
    ) -> dict[str, object]:
        query = (parameters.query or "").casefold().strip()
        evidence: list[dict[str, object]] = []
        transcript = self.library.load_transcript(asset_id)
        transcript_segments = transcript.segments if transcript else []
        for segment in transcript_segments:
            if not self._evidence_in_range(
                segment.start_seconds,
                segment.end_seconds,
                parameters.start_seconds,
                parameters.end_seconds,
            ):
                continue
            if query and query not in segment.text.casefold():
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
        if len(evidence) < parameters.limit:
            for segment in self.library.load_segments(asset_id):
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
                if not self._evidence_in_range(
                    segment.start_seconds,
                    segment.end_seconds,
                    parameters.start_seconds,
                    parameters.end_seconds,
                ):
                    continue
                if query and query not in text.casefold():
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
                if len(evidence) >= parameters.limit:
                    break
        return {"ok": True, "evidence": evidence, "truncated": len(evidence) >= parameters.limit}

    @staticmethod
    def _evidence_in_range(
        start: float,
        end: float,
        range_start: float | None,
        range_end: float | None,
    ) -> bool:
        return not (
            (range_start is not None and end < range_start)
            or (range_end is not None and start > range_end)
        )

    def _read_summary_document(
        self, asset_id: str, parameters: ReadSummaryDocumentInput
    ) -> dict[str, object]:
        document = self._require_document(parameters.document_id)
        if document.asset_id != asset_id:
            return {"ok": False, "error": "文档不属于当前视频"}
        return {
            "ok": True,
            "document": {
                "document_id": document.document_id,
                "title": document.title,
                "revision": document.revision,
                "markdown": document.markdown,
            },
        }

    def _propose_summary_change(
        self,
        session_id: str,
        request: SummaryAgentMessageRequest,
        document: SummaryDocument,
        parameters: ProposeSummaryChangeInput,
    ) -> dict[str, object]:
        current = self._require_document(document.document_id)
        if current.revision != request.expected_revision:
            return {
                "ok": False,
                "error": "文档版本冲突",
                "expected_revision": request.expected_revision,
                "current_revision": current.revision,
            }
        proposed_markdown = (
            parameters.proposed_markdown
            if parameters.proposed_markdown is not None
            else current.markdown
        )
        media_suggestions = [
            SummaryMediaSuggestion(
                suggestion_id=f"suggestion-{uuid7().hex}",
                **suggestion.model_dump(),
            )
            for suggestion in parameters.media_suggestions
        ]
        markdown_changed = proposed_markdown != current.markdown
        if (
            not markdown_changed
            and not parameters.suggested_subdocuments
            and not media_suggestions
        ):
            return {"ok": False, "error": "建议没有包含任何实际变化"}
        proposal = SummaryEditProposal(
            proposal_id=f"proposal-{uuid7().hex}",
            session_id=session_id,
            document_id=current.document_id,
            base_revision=current.revision,
            proposed_markdown=proposed_markdown,
            explanation=parameters.explanation,
            diff=_markdown_diff(current.markdown, proposed_markdown),
            suggested_subdocuments=parameters.suggested_subdocuments,
            media_suggestions=media_suggestions,
        )
        self.library.save_agent_summary_proposal(proposal)
        return {"ok": True, "proposal": proposal.model_dump(mode="json")}

    def _summary_agent_context(
        self, request: SummaryAgentMessageRequest, document: SummaryDocument
    ) -> str:
        documents = self._documents(document.asset_id)
        directory = "\n".join(
            f"- {item.document_id}: {item.title}（版本 {item.revision}）"
            for item in documents
        )
        selection = (
            f"当前选区 {request.selection.start}:{request.selection.end}："
            f"{request.selection.text}"
            if request.selection
            else "当前没有选区。"
        )
        return (
            f"当前文档：{document.document_id}（请求版本 {request.expected_revision}）\n"
            f"{selection}\n文档目录：\n{directory}"
        )

    def documents(self, asset_id: str) -> list[SummaryDocument]:
        self._require_asset(asset_id)
        return self._documents(asset_id)

    def generate(
        self,
        asset_id: str,
        request: SummaryGenerationRequest,
    ) -> list[SummaryDocument]:
        asset = self._require_asset(asset_id)
        existing = self._documents(asset_id)
        if existing:
            raise SummaryError("该视频已经生成总结文档")
        model = (
            self.settings.ai_model(request.ai_model_id) if request.ai_model_id else None
        )
        if request.ai_model_id and model is None:
            raise SummaryError("所选 AI 模型不存在")
        segments = self.library.load_segments(asset_id)
        transcript = self.library.load_transcript(asset_id)
        if transcript is None:
            raise SummaryError("请先完成视频转录")

        generated_title: str | None = None
        generated_markdown: str | None = None
        generated_children: list[SummaryDocumentCreate] = []
        if model is not None:
            try:
                response_content = complete_text(
                    model,
                    self._generation_messages(
                        asset.title,
                        transcript.segments,
                        segments,
                        request,
                    ),
                    SUMMARY_AGENT_TIMEOUT_SECONDS,
                    SUMMARY_AGENT_MAX_TOKENS,
                    True,
                )
            except LlmCompletionError as error:
                raise SummaryError(str(error)) from error
            generated_title, generated_markdown, generated_children = (
                _parse_generation_response(response_content)
            )

        root_id = f"document-{uuid7().hex}"
        children: list[SummaryDocument] = []
        if request.create_subdocuments:
            child_sources = generated_children or [
                SummaryDocumentCreate(
                    title=segment.title,
                    markdown=self._segment_markdown(segment, request.detail.value),
                )
                for segment in segments
            ]
            for position, child_source in enumerate(child_sources):
                document_id = f"document-{uuid7().hex}"
                children.append(
                    SummaryDocument(
                        document_id=document_id,
                        asset_id=asset_id,
                        parent_document_id=root_id,
                        title=child_source.title,
                        markdown=child_source.markdown,
                        position=position,
                    )
                )
        root_markdown = generated_markdown or self._root_markdown(
            asset.title,
            segments,
            children,
            request.detail.value,
        )
        if generated_markdown and children:
            root_markdown = _append_document_index(root_markdown, children)
        root = SummaryDocument(
            document_id=root_id,
            asset_id=asset_id,
            title=generated_title or f"{asset.title}总结",
            markdown=root_markdown,
        )
        documents = [root, *children]
        documents = [self._prepare_document(document) for document in documents]
        self._write_new_project(asset_id, documents)
        self.library.create_summary_documents(documents)
        root = documents[0]
        self.create_agent_session(
            asset_id, SummaryAgentSessionCreate(document_id=root.document_id)
        )
        return documents

    def create_child(
        self,
        root_document_id: str,
        request: SummaryDocumentCreate,
    ) -> SummaryDocument:
        root = self._require_document(root_document_id)
        if root.parent_document_id is not None:
            raise SummaryError("子文档下不能继续创建文档")
        children = [
            document
            for document in self._documents(root.asset_id)
            if document.parent_document_id == root.document_id
        ]
        document = self._prepare_document(
            SummaryDocument(
                document_id=f"document-{uuid7().hex}",
                asset_id=root.asset_id,
                parent_document_id=root.document_id,
                title=request.title,
                markdown=request.markdown,
                position=len(children),
            )
        )
        documents = [*self._documents(root.asset_id), document]
        try:
            self._write_document(document)
            self._write_manifest(root.asset_id, documents)
        except Exception:
            self._document_path(document).unlink(missing_ok=True)
            raise
        self.library.create_summary_documents([document])
        return document

    def update_document(
        self,
        document_id: str,
        request: SummaryDocumentUpdate,
    ) -> SummaryDocument:
        document = self._require_document(document_id)
        if document.revision != request.expected_revision:
            raise SummaryRevisionConflictError("文档版本冲突，请重新加载后再保存")
        updated_at = datetime.now(UTC)
        markdown = (
            request.markdown if request.markdown is not None else document.markdown
        )
        updated_document = document.model_copy(
            update={
                "title": request.title if request.title is not None else document.title,
                "markdown": markdown,
                "position": request.position
                if request.position is not None
                else document.position,
                "content_digest": markdown_digest(markdown),
                "revision": document.revision + 1,
                "updated_at": updated_at,
            }
        )
        current_documents = self._documents(document.asset_id)
        documents = [
            updated_document if item.document_id == document_id else item
            for item in current_documents
        ]
        if request.markdown is not None:
            self._write_document(updated_document)
        self._write_manifest(document.asset_id, documents)
        updated = self.library.update_summary_document(
            document_id,
            request.expected_revision,
            title=request.title,
            relative_path=updated_document.relative_path,
            content_digest=updated_document.content_digest,
            position=request.position,
        )
        if updated is None:
            raise SummaryRevisionConflictError("文档版本冲突，请重新加载后再保存")
        return updated

    def reorder_children(
        self, root_document_id: str, document_ids: list[str]
    ) -> list[SummaryDocument]:
        root = self._require_document(root_document_id)
        documents = self._documents(root.asset_id)
        positions = {
            document_id: position for position, document_id in enumerate(document_ids)
        }
        current_ids = {
            document.document_id
            for document in documents
            if document.parent_document_id == root_document_id
        }
        if set(document_ids) != current_ids or len(document_ids) != len(current_ids):
            raise ValueError("排序列表必须包含全部子文档且不能重复")
        now = datetime.now(UTC)
        reordered = [
            document.model_copy(
                update={
                    "position": positions[document.document_id],
                    "revision": document.revision + 1,
                    "updated_at": now,
                }
            )
            if document.document_id in positions
            else document
            for document in documents
        ]
        self._write_manifest(root.asset_id, reordered)
        self.library.reorder_summary_documents(root_document_id, document_ids)
        return self._documents(root.asset_id)

    def delete_child(self, document_id: str) -> None:
        document = self._require_document(document_id)
        if document.parent_document_id is None:
            raise ValueError("主文档不能单独删除")
        remaining = [
            item
            for item in self._documents(document.asset_id)
            if item.document_id != document_id
        ]
        self._write_manifest(document.asset_id, remaining)
        if not self.library.delete_summary_document(document_id):
            raise SummaryNotFoundError("总结文档不存在")
        self._document_path(document).unlink(missing_ok=True)

    def conversations(self, asset_id: str) -> list[SummaryConversation]:
        documents = self._documents(asset_id)
        if not any(document.parent_document_id is None for document in documents):
            raise SummaryNotFoundError("请先生成主文档")
        return self.library.load_summary_conversations(asset_id)

    def create_conversation(
        self,
        asset_id: str,
        request: SummaryConversationCreate,
    ) -> SummaryConversationState:
        documents = self._documents(asset_id)
        document = next(
            (item for item in documents if item.document_id == request.document_id),
            None,
        )
        root = next(
            (item for item in documents if item.parent_document_id is None),
            None,
        )
        if document is None or root is None:
            raise SummaryNotFoundError("总结文档不存在")
        conversation = self._create_conversation(root, document.title)
        return SummaryConversationState(
            conversation=conversation,
            messages=[],
            proposals=[],
        )

    def conversation_state(self, conversation_id: str) -> SummaryConversationState:
        try:
            conversation = self.library.load_summary_conversation_by_id(conversation_id)
        except ValueError as error:
            raise SummaryNotFoundError("总结会话不存在") from error
        if conversation is None:
            raise SummaryNotFoundError("总结会话不存在")
        return SummaryConversationState(
            conversation=conversation,
            messages=self.library.load_summary_messages(conversation.conversation_id),
            proposals=self.library.load_summary_proposals(conversation.conversation_id),
        )

    def delete_conversation(self, conversation_id: str) -> None:
        try:
            conversation = self.library.load_summary_conversation_by_id(conversation_id)
        except ValueError as error:
            raise SummaryNotFoundError("总结会话不存在") from error
        if conversation is None:
            raise SummaryNotFoundError("总结会话不存在")
        if len(self.library.load_summary_conversations(conversation.asset_id)) <= 1:
            raise SummaryError("至少保留一个 Agent 历史")
        active_runs = {
            SummaryAgentRunStage.PENDING,
            SummaryAgentRunStage.RUNNING,
        }
        if any(
            run.conversation_id == conversation_id and run.stage in active_runs
            for run in self.library.load_summary_agent_runs()
        ):
            raise SummaryError("Agent 正在运行，暂时不能删除该历史")
        if not self.library.delete_summary_conversation(conversation_id):
            raise SummaryNotFoundError("总结会话不存在")

    def create_agent_run(
        self,
        conversation_id: str,
        request: SummaryAgentMessageRequest,
    ) -> SummaryAgentRun:
        try:
            conversation = self.library.load_summary_conversation_by_id(conversation_id)
        except ValueError as error:
            raise SummaryNotFoundError("总结会话不存在") from error
        if conversation is None:
            raise SummaryNotFoundError("总结会话不存在")
        document = self._require_document(request.document_id)
        if document.asset_id != conversation.asset_id:
            raise SummaryNotFoundError("文档不属于该总结会话")
        if document.revision != request.expected_revision:
            raise SummaryRevisionConflictError("文档版本已变化，请重新发送指令")
        if self.settings.ai_model(request.ai_model_id) is None:
            raise SummaryError("所选 AI 模型不存在")
        instruction = request.instruction.strip()
        if not instruction:
            raise SummaryError("Agent 指令不能为空")
        is_first_message = not self.library.load_summary_messages(conversation_id)
        self.library.save_summary_message(
            SummaryMessage(
                message_id=f"message-{uuid7().hex}",
                conversation_id=conversation_id,
                role=SummaryMessageRole.USER,
                content=instruction,
            )
        )
        if is_first_message:
            title = instruction.splitlines()[0]
            title = title[:SUMMARY_CONVERSATION_TITLE_LENGTH]
            self.library.update_summary_conversation_title(
                conversation_id,
                title,
                datetime.now(UTC),
            )
        run = SummaryAgentRun(
            run_id=f"run-{uuid7().hex}",
            conversation_id=conversation_id,
        )
        self.library.save_summary_agent_run(run)
        task = asyncio.create_task(self._execute_agent_run(run, request, document))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)
        return run

    async def _execute_agent_run(
        self,
        run: SummaryAgentRun,
        request: SummaryAgentMessageRequest,
        document: SummaryDocument,
    ) -> None:
        running = run.model_copy(
            update={
                "stage": SummaryAgentRunStage.RUNNING,
                "updated_at": datetime.now(UTC),
            }
        )
        self.library.save_summary_agent_run(running)
        model = self.settings.ai_model(request.ai_model_id)
        if model is None:
            self._fail_run(running, "所选 AI 模型不存在")
            return
        documents = self._documents(document.asset_id)
        segments = self.library.load_segments(document.asset_id)
        prompt = self._agent_prompt(request, document, documents, segments)
        conversation_messages = self.library.load_summary_messages(run.conversation_id)[
            :-1
        ]
        history: list[dict[str, str]] = []
        history_length = 0
        for message in reversed(conversation_messages):
            if (
                history_length + len(message.content)
                > SUMMARY_CONVERSATION_CONTEXT_LIMIT
            ):
                break
            history.append({"role": message.role.value, "content": message.content})
            history_length += len(message.content)
        history.reverse()
        try:
            response_content = await asyncio.to_thread(
                complete_text,
                model,
                [
                    {
                        "role": "system",
                        "content": (
                            "你是视频知识文档编辑。返回 JSON 对象，字段为 proposed_markdown、"
                            "explanation、suggested_subdocuments、media_suggestions。"
                            "子文档项包含 title 和 markdown；媒体项包含 media_type、start_seconds、"
                            "end_seconds、insert_after、caption。不要输出推理过程或代码围栏。"
                        ),
                    },
                    *history,
                    {"role": "user", "content": prompt},
                ],
                SUMMARY_AGENT_TIMEOUT_SECONDS,
                SUMMARY_AGENT_MAX_TOKENS,
                True,
            )
            (
                proposed_markdown,
                explanation,
                suggested_subdocuments,
                media_suggestions,
            ) = _parse_agent_response(response_content, request.instruction)
            assistant_message = SummaryMessage(
                message_id=f"message-{uuid7().hex}",
                conversation_id=run.conversation_id,
                role=SummaryMessageRole.ASSISTANT,
                content="我已整理修改建议。确认后才会应用到文档。",
            )
            self.library.save_summary_message(assistant_message)
            proposal = SummaryEditProposal(
                proposal_id=f"proposal-{uuid7().hex}",
                conversation_id=run.conversation_id,
                document_id=document.document_id,
                base_revision=document.revision,
                proposed_markdown=proposed_markdown,
                explanation=explanation,
                diff=_markdown_diff(document.markdown, proposed_markdown),
                suggested_subdocuments=suggested_subdocuments,
                media_suggestions=media_suggestions,
            )
            self.library.save_summary_proposal(proposal)
            self.library.save_summary_agent_run(
                running.model_copy(
                    update={
                        "stage": SummaryAgentRunStage.COMPLETE,
                        "assistant_message_id": assistant_message.message_id,
                        "proposal_id": proposal.proposal_id,
                        "updated_at": datetime.now(UTC),
                    }
                )
            )
        except LlmCompletionError as error:
            self._fail_run(running, str(error))
        except Exception as error:
            self._fail_run(running, str(error) or "总结 Agent 运行失败")

    def _fail_run(self, run: SummaryAgentRun, message: str) -> None:
        self.library.save_summary_agent_run(
            run.model_copy(
                update={
                    "stage": SummaryAgentRunStage.FAILED,
                    "error_message": message,
                    "updated_at": datetime.now(UTC),
                }
            )
        )

    def agent_run(self, run_id: str) -> SummaryAgentRun:
        try:
            run = self.library.load_summary_agent_run(run_id)
        except ValueError as error:
            raise SummaryNotFoundError("Agent 运行不存在") from error
        if run is None:
            raise SummaryNotFoundError("Agent 运行不存在")
        return run

    def accept_proposal(self, proposal_id: str) -> SummaryEditProposal:
        proposal = self._require_proposal(proposal_id)
        if proposal.status != SummaryProposalStatus.PENDING:
            return proposal
        document = self._require_document(proposal.document_id)
        if document.revision != proposal.base_revision:
            stale = proposal.model_copy(update={"status": SummaryProposalStatus.STALE})
            self._save_proposal(stale)
            raise SummaryRevisionConflictError("建议基于旧版本，已标记为过期")
        try:
            self.update_document(
                document.document_id,
                SummaryDocumentUpdate(
                    expected_revision=proposal.base_revision,
                    markdown=proposal.proposed_markdown,
                ),
            )
        except SummaryRevisionConflictError:
            stale = proposal.model_copy(update={"status": SummaryProposalStatus.STALE})
            self._save_proposal(stale)
            raise SummaryRevisionConflictError("建议基于旧版本，已标记为过期")
        for suggestion in proposal.suggested_subdocuments:
            root = next(
                (
                    item
                    for item in self._documents(document.asset_id)
                    if item.parent_document_id is None
                ),
                None,
            )
            if root is not None:
                self.create_child(root.document_id, suggestion)
        accepted = proposal.model_copy(
            update={"status": SummaryProposalStatus.ACCEPTED}
        )
        self._save_proposal(accepted)
        return accepted

    def reject_proposal(self, proposal_id: str) -> SummaryEditProposal:
        proposal = self._require_proposal(proposal_id)
        if proposal.status != SummaryProposalStatus.PENDING:
            return proposal
        rejected = proposal.model_copy(
            update={"status": SummaryProposalStatus.REJECTED}
        )
        self._save_proposal(rejected)
        return rejected

    async def create_media(
        self, request: SummaryMediaCreate
    ) -> tuple[SummaryMediaArtifact, SummaryDocument]:
        document = self._require_document(request.document_id)
        if document.revision != request.expected_revision:
            raise SummaryRevisionConflictError("文档版本冲突，请重新选择插入位置")
        asset = self._require_asset(document.asset_id)
        duration = asset.duration_seconds
        end_seconds = request.end_seconds
        if request.media_type == SummaryMediaType.GIF and end_seconds is None:
            end_seconds = request.start_seconds + GIF_DEFAULT_DURATION_SECONDS
        if request.start_seconds < 0 or (
            duration is not None and request.start_seconds >= duration
        ):
            raise SummaryError("媒体时间点超出视频范围")
        if end_seconds is not None and duration is not None and end_seconds > duration:
            raise SummaryError("媒体时间范围超出视频范围")
        playback = self.library.resolve_asset_file(asset, asset.playback_path)
        if playback is None:
            raise SummaryError("视频文件不存在")
        media_id = f"media-{uuid7().hex}"
        suffix = ".jpg" if request.media_type == SummaryMediaType.IMAGE else ".gif"
        relative_path = (
            f"{SUMMARY_DIRECTORY_NAME}/{SUMMARY_ASSETS_DIRECTORY_NAME}/"
            f"{media_id}{suffix}"
        )
        try:
            output_path = resolve_summary_path(
                self.library.asset_directory(asset.asset_id),
                f"{SUMMARY_ASSETS_DIRECTORY_NAME}/{media_id}{suffix}",
            )
        except ValueError as error:
            raise SummaryError(str(error)) from error
        try:
            await asyncio.to_thread(
                generate_summary_media,
                playback,
                output_path,
                request.media_type,
                request.start_seconds,
                end_seconds,
                self.settings.ffmpeg_path,
                self.settings.ffmpeg_bin_dir,
            )
        except SummaryMediaError as error:
            raise SummaryError(str(error)) from error
        artifact = SummaryMediaArtifact(
            media_id=media_id,
            asset_id=asset.asset_id,
            document_id=document.document_id,
            media_type=request.media_type,
            relative_path=relative_path,
            caption=request.caption,
            start_seconds=request.start_seconds,
            end_seconds=end_seconds,
        )
        markdown_path = (
            f"assets/{media_id}{suffix}"
            if document.parent_document_id is None
            else f"../assets/{media_id}{suffix}"
        )
        media_markdown = f"![{request.caption}]({markdown_path})"
        updated_markdown = _insert_markdown(
            document.markdown,
            request.insert_after,
            media_markdown,
        )
        try:
            updated = self.update_document(
                document.document_id,
                SummaryDocumentUpdate(
                    expected_revision=document.revision,
                    markdown=updated_markdown,
                ),
            )
        except SummaryRevisionConflictError:
            raise SummaryRevisionConflictError("媒体已生成，但文档版本发生冲突")
        self.library.save_summary_media(artifact)
        self._write_manifest(
            asset.asset_id,
            self.library.load_summary_documents(asset.asset_id),
        )
        return artifact, updated

    def export(self, asset_id: str) -> SummaryExportResult:
        asset = self._require_asset(asset_id)
        documents = self._documents(asset_id)
        root = next(
            (document for document in documents if document.parent_document_id is None),
            None,
        )
        if root is None:
            raise SummaryNotFoundError("请先生成主文档")
        children = [
            document
            for document in documents
            if document.parent_document_id is not None
        ]
        media = self.library.load_summary_media(asset_id)
        exported_at = datetime.now().astimezone()
        manifest = {
            "format_version": 1,
            "asset": {
                "asset_id": asset.asset_id,
                "title": asset.title,
                "source_url": asset.source_url,
                "source_platform": asset.source_platform.value,
            },
            "root_document_id": root.document_id,
            "documents": [
                {
                    "document_id": document.document_id,
                    "parent_document_id": document.parent_document_id,
                    "title": document.title,
                    "revision": document.revision,
                    "relative_path": document.relative_path,
                    "content_digest": document.content_digest,
                }
                for document in documents
            ],
            "media": [artifact.model_dump(mode="json") for artifact in media],
            "exported_at": exported_at.isoformat(timespec="milliseconds"),
        }
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("index.md", root.markdown)
            for child in children:
                archive.writestr(child.relative_path, child.markdown)
            for artifact in media:
                try:
                    resolved_source = self._artifact_path(artifact)
                except (OSError, ValueError):
                    raise SummaryError(f"总结资源缺失：{artifact.media_id}")
                archive.write(resolved_source, f"assets/{resolved_source.name}")
            archive.writestr(
                "manifest.json",
                json.dumps(manifest, ensure_ascii=False, indent=2),
            )
        export_id = f"export-{uuid7().hex}"
        timestamp = exported_at.strftime(EXPORT_FILE_NAME_TIME_FORMAT)[:-3]
        file_name = f"summary-{timestamp}-{export_id}.zip"
        output_directory = (
            self.library.asset_directory(asset_id) / SUMMARY_OUTPUT_DIRECTORY_NAME
        )
        if output_directory.is_symlink():
            raise SummaryError("总结导出目录不能是符号链接")
        output_path = output_directory / file_name
        content = buffer.getvalue()
        atomic_write_bytes(output_path, content)
        relative_path = output_path.relative_to(
            self.library.asset_directory(asset_id)
        ).as_posix()
        return SummaryExportResult(
            export_id=export_id,
            relative_path=relative_path,
            file_name=file_name,
            size_bytes=len(content),
            exported_at=exported_at,
        )

    def media_path(self, media_id: str):
        artifacts = [
            artifact
            for asset in self.library.list()
            for artifact in self.library.load_summary_media(asset.asset_id)
            if artifact.media_id == media_id
        ]
        if not artifacts:
            raise SummaryNotFoundError("总结媒体不存在")
        artifact = artifacts[0]
        try:
            return self._artifact_path(artifact)
        except (OSError, ValueError):
            raise SummaryNotFoundError("总结媒体文件不存在")

    def _artifact_path(self, artifact: SummaryMediaArtifact) -> Path:
        prefix = f"{SUMMARY_DIRECTORY_NAME}/"
        if not artifact.relative_path.startswith(prefix):
            raise ValueError("总结媒体路径无效")
        relative_path = artifact.relative_path.removeprefix(prefix)
        return resolve_summary_path(
            self.library.asset_directory(artifact.asset_id),
            relative_path,
            require_file=True,
        )

    def _documents(self, asset_id: str) -> list[SummaryDocument]:
        return self.library.load_summary_documents(asset_id)

    def _prepare_document(self, document: SummaryDocument) -> SummaryDocument:
        relative_path = document_relative_path(document)
        return document.model_copy(
            update={
                "relative_path": relative_path,
                "content_digest": markdown_digest(document.markdown),
            }
        )

    def _document_path(self, document: SummaryDocument) -> Path:
        return resolve_summary_path(
            self.library.asset_directory(document.asset_id),
            document.relative_path,
        )

    def _write_document(self, document: SummaryDocument) -> None:
        atomic_write_text(self._document_path(document), document.markdown)

    def _write_manifest(
        self,
        asset_id: str,
        documents: list[SummaryDocument],
    ) -> None:
        manifest = build_manifest(
            asset_id,
            documents,
            self.library.load_summary_media(asset_id),
        )
        write_manifest(self.library.asset_directory(asset_id), manifest)

    def _write_new_project(
        self,
        asset_id: str,
        documents: list[SummaryDocument],
    ) -> None:
        try:
            for document in documents:
                self._write_document(document)
            self._write_manifest(asset_id, documents)
        except Exception:
            self._remove_project_files(asset_id, documents)
            raise

    def _remove_project_files(
        self,
        asset_id: str,
        documents: list[SummaryDocument],
    ) -> None:
        for document in documents:
            self._document_path(document).unlink(missing_ok=True)
        manifest_path = resolve_summary_path(
            self.library.asset_directory(asset_id), SUMMARY_MANIFEST_FILE_NAME
        )
        manifest_path.unlink(missing_ok=True)

    def _create_conversation(
        self,
        root: SummaryDocument,
        title: str,
    ) -> SummaryConversation:
        conversation = SummaryConversation(
            conversation_id=f"conversation-{uuid7().hex}",
            asset_id=root.asset_id,
            root_document_id=root.document_id,
            title=title,
        )
        self.library.save_summary_conversation(conversation)
        return conversation

    def _require_asset(self, asset_id: str):
        try:
            asset = self.library.get(asset_id)
        except ValueError as error:
            raise SummaryNotFoundError("视频不存在或尚未就绪") from error
        if asset is None or asset.status != MediaAssetStatus.READY:
            raise SummaryNotFoundError("视频不存在或尚未就绪")
        return asset

    def _require_document(self, document_id: str) -> SummaryDocument:
        try:
            document = self.library.load_summary_document(document_id)
        except ValueError as error:
            raise SummaryNotFoundError("总结文档不存在") from error
        if document is None:
            raise SummaryNotFoundError("总结文档不存在")
        return next(
            item
            for item in self._documents(document.asset_id)
            if item.document_id == document_id
        )

    def _require_proposal(self, proposal_id: str) -> SummaryEditProposal:
        try:
            proposal = self.library.load_agent_summary_proposal(proposal_id)
        except ValueError as error:
            raise SummaryNotFoundError("修改建议不存在") from error
        if proposal is None:
            raise SummaryNotFoundError("修改建议不存在")
        return proposal

    def _save_proposal(self, proposal: SummaryEditProposal) -> None:
        self.library.save_agent_summary_proposal(proposal)

    @staticmethod
    def _root_markdown(
        title: str,
        segments: list[MediaSegment],
        children: list[SummaryDocument],
        detail: str,
    ) -> str:
        lines = [f"# {title}", "", "> 本文根据视频转录、时间轴事件与用户标记生成。", ""]
        if children:
            lines.extend(("## 文档目录", ""))
            lines.extend(
                f"- [{child.title}](docs/{child.document_id}.md)" for child in children
            )
            lines.append("")
        lines.extend(("## 内容提要", ""))
        if not segments:
            lines.append("尚无时间轴分析结果，可在分析页完成内容分析后再补充。")
        for segment in segments:
            timestamp = _timestamp(segment.start_seconds)
            summary = (
                segment.detailed_summary
                or segment.transcript_text
                or "该片段暂无文字说明。"
            )
            if detail == "concise":
                summary = summary[:180]
            lines.extend((f"### [{timestamp}] {segment.title}", "", summary, ""))
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _segment_markdown(segment: MediaSegment, detail: str) -> str:
        summary = (
            segment.detailed_summary
            or segment.transcript_text
            or "该片段暂无文字说明。"
        )
        lines = [
            f"# {segment.title}",
            "",
            f"时间范围：{_timestamp(segment.start_seconds)}–{_timestamp(segment.end_seconds)}",
            "",
            "## 笔记",
            "",
            summary,
        ]
        if detail == "detailed" and segment.visual_description:
            lines.extend(("", "## 画面信息", "", segment.visual_description))
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _agent_prompt(
        request: SummaryAgentMessageRequest,
        document: SummaryDocument,
        documents: list[SummaryDocument],
        segments: list[MediaSegment],
    ) -> str:
        directory = "\n".join(
            f"- {item.document_id}: {item.title}（版本 {item.revision}）"
            for item in documents
        )
        evidence = "\n".join(
            f"[{_timestamp(segment.start_seconds)}] {segment.title}: "
            f"{segment.detailed_summary or segment.transcript_text or ''}"
            for segment in segments
        )[:20_000]
        selection = (
            f"选区 {request.selection.start}:{request.selection.end}：{request.selection.text}"
            if request.selection
            else "未提供选区，可调整当前全文。"
        )
        return (
            f"用户指令：{request.instruction}\n\n{selection}\n\n"
            f"文档目录：\n{directory}\n\n相关视频证据：\n{evidence}\n\n"
            f"当前 Markdown：\n{document.markdown}"
        )

    @staticmethod
    def _generation_messages(
        asset_title: str,
        transcript_segments: list[TranscriptSegment],
        segments: list[MediaSegment],
        request: SummaryGenerationRequest,
    ) -> list[dict[str, object]]:
        transcript_context = "\n".join(
            f"[{_timestamp(segment.start_seconds)}] {segment.text}"
            for segment in transcript_segments
        )
        analysis_context = "\n".join(
            f"[{_timestamp(segment.start_seconds)}] {segment.title}: "
            f"{segment.detailed_summary or segment.transcript_text or ''}"
            for segment in segments
        )
        context = (
            f"视频标题：{asset_title}\n\n转录：\n{transcript_context}\n\n"
            f"分析片段：\n{analysis_context}"
        )[:SUMMARY_GENERATION_CONTEXT_LIMIT]
        child_instruction = (
            "按章节返回一级子文档，每项包含 title 和 markdown。"
            if request.create_subdocuments
            else "subdocuments 必须返回空数组。"
        )
        return [
            {
                "role": "system",
                "content": (
                    "你是视频知识文档编辑。只返回 JSON 对象，字段为 title、markdown、"
                    "subdocuments。markdown 是完整主文档；subdocuments 是数组。"
                    "保留关键时间戳，不输出推理过程或代码围栏。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"文档详细度：{request.detail.value}。{child_instruction}\n\n{context}"
                ),
            },
        ]


def _timestamp(seconds: float) -> str:
    total_seconds = max(0, int(seconds))
    minutes, second = divmod(total_seconds, 60)
    hour, minute = divmod(minutes, 60)
    return (
        f"{hour:02d}:{minute:02d}:{second:02d}"
        if hour
        else f"{minute:02d}:{second:02d}"
    )


def _markdown_diff(original: str, proposed: str) -> str:
    return "".join(
        difflib.unified_diff(
            original.splitlines(keepends=True),
            proposed.splitlines(keepends=True),
            fromfile="current.md",
            tofile="proposed.md",
        )
    )


def _strip_code_fence(content: str) -> str:
    match = re.fullmatch(
        r"```(?:markdown|md|json)?\s*\n(?P<body>.*)\n```",
        content,
        re.DOTALL,
    )
    return match.group("body") if match else content


def _parse_agent_response(
    content: str,
    fallback_explanation: str,
) -> tuple[
    str,
    str,
    list[SummaryDocumentCreate],
    list[SummaryMediaSuggestion],
]:
    normalized = _strip_code_fence(content).strip()
    try:
        payload = json.loads(normalized)
    except json.JSONDecodeError:
        return normalized, fallback_explanation, [], []
    if not isinstance(payload, dict) or not isinstance(
        payload.get("proposed_markdown"), str
    ):
        return normalized, fallback_explanation, [], []
    subdocuments: list[SummaryDocumentCreate] = []
    for item in payload.get("suggested_subdocuments", []):
        if not isinstance(item, dict):
            continue
        try:
            subdocuments.append(SummaryDocumentCreate.model_validate(item))
        except ValueError:
            continue
    media_suggestions: list[SummaryMediaSuggestion] = []
    for item in payload.get("media_suggestions", []):
        if not isinstance(item, dict):
            continue
        try:
            media_suggestions.append(
                SummaryMediaSuggestion.model_validate(
                    {
                        **item,
                        "suggestion_id": f"suggestion-{uuid7().hex}",
                    }
                )
            )
        except ValueError:
            continue
    explanation = payload.get("explanation")
    return (
        payload["proposed_markdown"],
        explanation if isinstance(explanation, str) else fallback_explanation,
        subdocuments,
        media_suggestions,
    )


def _parse_generation_response(
    content: str,
) -> tuple[str | None, str, list[SummaryDocumentCreate]]:
    normalized = _strip_code_fence(content).strip()
    try:
        payload = json.loads(normalized)
    except json.JSONDecodeError as error:
        raise SummaryError("AI 未返回有效的总结文档结构") from error
    if not isinstance(payload, dict) or not isinstance(payload.get("markdown"), str):
        raise SummaryError("AI 未返回有效的总结文档结构")
    markdown = payload["markdown"].strip()
    if not markdown:
        raise SummaryError("AI 返回的主文档为空")
    title = payload.get("title")
    if not isinstance(title, str) or not title.strip():
        title = None
    subdocuments: list[SummaryDocumentCreate] = []
    for item in payload.get("subdocuments", []):
        if not isinstance(item, dict):
            continue
        try:
            subdocuments.append(SummaryDocumentCreate.model_validate(item))
        except ValueError:
            continue
    return title.strip() if title else None, markdown + "\n", subdocuments


def _append_document_index(
    markdown: str,
    children: list[SummaryDocument],
) -> str:
    index_lines = ["## 文档目录", ""]
    index_lines.extend(
        f"- [{child.title}](docs/{child.document_id}.md)" for child in children
    )
    index_markdown = "\n".join(index_lines)
    return f"{markdown.rstrip()}\n\n{index_markdown}\n"


def _insert_markdown(
    markdown: str, insert_after: str | None, media_markdown: str
) -> str:
    if insert_after and insert_after in markdown:
        insertion_index = markdown.index(insert_after) + len(insert_after)
        return f"{markdown[:insertion_index]}\n\n{media_markdown}{markdown[insertion_index:]}"
    return f"{markdown.rstrip()}\n\n{media_markdown}\n"
