"""首次总结的渐进配图任务与证据驱动选帧。"""

from __future__ import annotations

import asyncio
from datetime import UTC, datetime
import hashlib
import json
from pathlib import Path
import tempfile
from threading import RLock
from time import monotonic

from pydantic import BaseModel, ConfigDict, Field, ValidationError

from openvideo.agent_model_roles import select_automatic_model_id
from openvideo.agent_retrieval_models import NeuralRetrievalModels
from openvideo.core.agent_evidence_index import IndexedEvidenceDocument
from openvideo.core.agent_evidence_models import AgentEvidenceSource
from openvideo.core.agent_governance_models import AgentModelRole
from openvideo.core.ai_models import IMAGE_INPUT_MODALITY
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaMarker
from openvideo.core.summary_models import (
    SummaryDetail,
    SummaryIllustrationConfidence,
    SummaryIllustrationJob,
    SummaryIllustrationSlot,
    SummaryIllustrationSlotStatus,
    SummaryIllustrationStage,
    SummaryMediaCreate,
    SummaryMediaOrigin,
    SummaryMediaProvenance,
    SummaryMediaType,
    TERMINAL_SUMMARY_ILLUSTRATION_STAGES,
)
from openvideo.core.visual_index_models import VisualIndexState
from openvideo.llm.capability_resolver import CapabilityResolver
from openvideo.settings import Settings
from openvideo.summary_manager import SummaryManager
from openvideo.tools.frame_quality import QualifiedFrame, filter_candidate_frames
from openvideo.tools.frames import extract_frames
from openvideo.tools.llm import LlmCompletionError, complete_text, probe_image_input
from openvideo.tools.scenes import refine_scene_candidates
from openvideo.tools.vision import LiteLlmVision, VisionDescriptionError
from openvideo.visual_index_service import VisualIndexService


ILLUSTRATION_PLAN_TIMEOUT_SECONDS = 120
ILLUSTRATION_PLAN_MAX_TOKENS = 2_500
VISION_MODEL_PROBE_TIMEOUT_SECONDS = 30
EVIDENCE_LIMIT = 12
EVIDENCE_WINDOW_PADDING_SECONDS = 4
MINIMUM_EVIDENCE_WINDOW_SECONDS = 6
MAXIMUM_DIRECT_EVIDENCE_WINDOW_SECONDS = 120
FORMAL_MARKER_SCORE_PER_LEVEL = 0.04
DETAIL_SLOT_LIMITS = {
    SummaryDetail.CONCISE: 2,
    SummaryDetail.STANDARD: 4,
    SummaryDetail.DETAILED: 6,
}


class IllustrationPlanSlot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    document_id: str
    heading_path: list[str] = Field(default_factory=list, max_length=12)
    target_excerpt: str = Field(min_length=8, max_length=500)
    retrieval_query: str = Field(min_length=2, max_length=500)
    caption: str = Field(min_length=1, max_length=500)


class IllustrationPlan(BaseModel):
    model_config = ConfigDict(extra="forbid")

    slots: list[IllustrationPlanSlot] = Field(default_factory=list, max_length=6)


class VisionFrameDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")

    selected_index: int | None = Field(default=None, ge=1, le=7)
    confidence: SummaryIllustrationConfidence
    reason: str = Field(min_length=1, max_length=2_000)


class SummaryIllustrationError(RuntimeError):
    """配图任务无法继续，但不影响已经生成的总结正文。"""


class SummaryIllustrationManager:
    """把昂贵选图与正文请求解耦，并保证每一步可以在重启后恢复。"""

    def __init__(
        self,
        library: MediaLibrary,
        settings: Settings,
        summary_manager: SummaryManager,
        capability_resolver: CapabilityResolver,
        retrieval_models: NeuralRetrievalModels | None = None,
        visual_index_service: VisualIndexService | None = None,
    ) -> None:
        self.library = library
        self.settings = settings
        self.summary_manager = summary_manager
        self.capability_resolver = capability_resolver
        self.retrieval_models = retrieval_models
        self.visual_index_service = visual_index_service
        self._jobs: dict[str, SummaryIllustrationJob] = {}
        self._tasks: dict[str, asyncio.Task[None]] = {}
        self._vision_probe_errors: dict[
            tuple[str, str, str, str, str], str | None
        ] = {}
        self._lock = RLock()

    def create(
        self,
        asset_id: str,
        version_id: str,
        planning_model_id: str,
    ) -> SummaryIllustrationJob:
        version = next(
            (
                item
                for item in self.library.load_summary_versions(asset_id)
                if item.version_id == version_id
            ),
            None,
        )
        if version is None:
            raise SummaryIllustrationError("总结版本不存在，无法创建配图任务")
        existing = self.library.load_summary_illustration_jobs(version_id=version_id)
        if existing:
            return existing[0]
        job = SummaryIllustrationJob(
            job_id=f"summary-illustration-job-{uuid7().hex}",
            asset_id=asset_id,
            version_id=version_id,
            planning_model_id=planning_model_id,
            vision_model_id=self._vision_model_id(),
        )
        with self._lock:
            self._jobs[job.job_id] = job
        self.library.save_summary_illustration_job(job)
        return job.model_copy(deep=True)

    def get(self, job_id: str) -> SummaryIllustrationJob | None:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            job = self.library.load_summary_illustration_job(job_id)
            if job is not None:
                with self._lock:
                    self._jobs[job_id] = job
        return job.model_copy(deep=True) if job is not None else None

    def latest_for_version(self, version_id: str) -> SummaryIllustrationJob | None:
        jobs = self.library.load_summary_illustration_jobs(version_id=version_id)
        return jobs[0] if jobs else None

    def start(self, job_id: str) -> None:
        job = self.get(job_id)
        if job is None or job.stage in TERMINAL_SUMMARY_ILLUSTRATION_STAGES:
            return
        with self._lock:
            active = self._tasks.get(job_id)
            if active is not None and not active.done():
                return
            self._tasks[job_id] = asyncio.create_task(self._run(job_id))

    def restore(self) -> None:
        for job in self.library.load_summary_illustration_jobs():
            with self._lock:
                self._jobs[job.job_id] = job
            if job.stage not in TERMINAL_SUMMARY_ILLUSTRATION_STAGES:
                self._update(
                    job.job_id,
                    stage=SummaryIllustrationStage.PENDING,
                    message="正在恢复配图任务",
                    error_message=None,
                )
                self.start(job.job_id)

    async def _run(self, job_id: str) -> None:
        try:
            job = self._require_job(job_id)
            if job.vision_model_id is None:
                self._update(
                    job_id,
                    stage=SummaryIllustrationStage.COMPLETE,
                    progress_percent=100,
                    message="未配置可用的视觉模型，已保留纯文本总结",
                )
                return
            vision_error = await asyncio.to_thread(
                self._vision_model_error,
                job.vision_model_id,
            )
            if vision_error is not None:
                self._update(
                    job_id,
                    stage=SummaryIllustrationStage.COMPLETE,
                    progress_percent=100,
                    message=f"视觉模型未通过画面读取验证，已保留纯文本总结：{vision_error}",
                )
                return
            if not job.slots:
                self._update(
                    job_id,
                    stage=SummaryIllustrationStage.PLANNING,
                    progress_percent=4,
                    message="正在判断哪些内容最需要画面",
                )
                phase_started = monotonic()
                plan = await asyncio.to_thread(self._plan, job)
                self._record_metrics(
                    job_id,
                    planning_ms=_elapsed_ms(phase_started),
                )
                slots = [
                    SummaryIllustrationSlot(
                        slot_id=f"illustration-slot-{uuid7().hex}",
                        **slot.model_dump(),
                    )
                    for slot in plan.slots
                ]
                self._update(job_id, slots=slots)
            job = self._require_job(job_id)
            if not job.slots:
                self._update(
                    job_id,
                    stage=SummaryIllustrationStage.COMPLETE,
                    progress_percent=100,
                    message="当前总结不需要额外画面",
                )
                return
            for index, slot in enumerate(job.slots):
                if slot.status in {
                    SummaryIllustrationSlotStatus.INSERTED,
                    SummaryIllustrationSlotStatus.SKIPPED,
                }:
                    continue
                try:
                    await self._process_slot(job_id, slot.slot_id)
                except asyncio.CancelledError:
                    raise
                except Exception as error:
                    self._skip_slot(job_id, slot.slot_id, str(error) or "候选处理失败")
                completed = index + 1
                self._update(
                    job_id,
                    progress_percent=10 + 88 * completed / len(job.slots),
                )
            job = self._require_job(job_id)
            self._update(
                job_id,
                stage=SummaryIllustrationStage.COMPLETE,
                progress_percent=100,
                message=(
                    f"配图完成：已插入 {job.inserted_count} 张，"
                    f"跳过 {job.skipped_count} 张"
                ),
            )
        except asyncio.CancelledError:
            self._update(
                job_id,
                stage=SummaryIllustrationStage.PENDING,
                message="等待恢复配图任务",
            )
            raise
        except Exception as error:
            self._update(
                job_id,
                stage=SummaryIllustrationStage.FAILED,
                progress_percent=100,
                message="配图未完成，正文不受影响",
                error_message=str(error) or "配图任务失败",
            )

    def _plan(self, job: SummaryIllustrationJob) -> IllustrationPlan:
        model = self.settings.ai_model(job.planning_model_id)
        if model is None:
            raise SummaryIllustrationError("总结所用模型已不可用")
        version = next(
            item
            for item in self.library.load_summary_versions(job.asset_id)
            if item.version_id == job.version_id
        )
        documents = self.library.load_summary_documents(job.asset_id, job.version_id)
        document_payload = [
            {
                "document_id": document.document_id,
                "parent_document_id": document.parent_document_id,
                "title": document.title,
                "markdown": document.markdown,
            }
            for document in documents
        ]
        slot_limit = DETAIL_SLOT_LIMITS[version.detail]
        messages = [
            {
                "role": "system",
                "content": (
                    "你负责为已经完成的 Markdown 视频笔记规划少量静态截图。"
                    '只返回 JSON：{"slots":[{"document_id":"...",'
                    '"heading_path":["..."],"target_excerpt":"...",'
                    '"retrieval_query":"...","caption":"..."}]}。'
                    "target_excerpt 必须逐字摘自目标文档且在该文档中只出现一次，"
                    "应位于图片插入点之前。只选择没有画面就难理解、能被视频画面直接"
                    "证明的内容；装饰图、说话人镜头和纯文字可充分说明的内容不要选。"
                    "允许返回空 slots。"
                ),
            },
            {
                "role": "user",
                "content": (
                    f"最多规划 {slot_limit} 张图。输出语言：{version.output_language}。"
                    "\n\n<最终文档树>\n"
                    + json.dumps(document_payload, ensure_ascii=False)
                    + "\n</最终文档树>"
                ),
            },
        ]
        try:
            content = complete_text(
                model,
                messages,
                ILLUSTRATION_PLAN_TIMEOUT_SECONDS,
                ILLUSTRATION_PLAN_MAX_TOKENS,
                True,
            )
            plan = IllustrationPlan.model_validate_json(_json_content(content))
        except (LlmCompletionError, ValidationError, ValueError) as error:
            raise SummaryIllustrationError(f"配图规划无效：{error}") from error
        validated_slots = []
        by_id = {document.document_id: document for document in documents}
        for slot in plan.slots[:slot_limit]:
            document = by_id.get(slot.document_id)
            if document is None or document.markdown.count(slot.target_excerpt) != 1:
                continue
            validated_slots.append(slot)
        return IllustrationPlan(slots=validated_slots)

    async def _process_slot(self, job_id: str, slot_id: str) -> None:
        job = self._require_job(job_id)
        slot = _slot(job, slot_id)
        self._update_slot(
            job_id,
            slot_id,
            status=SummaryIllustrationSlotStatus.LOCATING,
            message="正在检索对应的视频证据",
        )
        self._update(
            job_id,
            stage=SummaryIllustrationStage.RETRIEVING,
            message="正在定位关键画面",
        )
        phase_started = monotonic()
        evidence = await asyncio.to_thread(self._retrieve_evidence, job, slot)
        self._record_metrics(
            job_id,
            retrieval_ms=_elapsed_ms(phase_started),
        )
        if evidence is None:
            visual_index_state = (
                self.visual_index_service.status().state
                if self.visual_index_service is not None
                else None
            )
            if self.visual_index_service is not None and visual_index_state in {
                VisualIndexState.NOT_PREPARED,
                VisualIndexState.ERROR,
            }:
                self.visual_index_service.prepare(job.asset_id)
                self._skip_slot(
                    job_id,
                    slot_id,
                    "文本证据不足，已在后台按需准备视觉索引",
                )
            else:
                self._skip_slot(job_id, slot_id, "没有找到足够相关的视频证据")
            return
        asset = self.library.get(job.asset_id)
        if asset is None:
            raise SummaryIllustrationError("视频素材不存在")
        playback = self.library.resolve_asset_file(asset, asset.playback_path)
        if playback is None:
            raise SummaryIllustrationError("视频文件不存在")
        start_seconds, end_seconds = _evidence_window(
            evidence,
            asset.duration_seconds,
        )
        candidate_count = _candidate_count(start_seconds, end_seconds)
        self._update(
            job_id,
            stage=SummaryIllustrationStage.EXTRACTING,
            message="正在细分候选画面",
        )
        phase_started = monotonic()
        candidate_times = await asyncio.to_thread(
            refine_scene_candidates,
            playback,
            start_seconds,
            end_seconds,
            candidate_count,
            self.settings.ffmpeg_path,
            self.settings.ffmpeg_bin_dir,
        )
        with tempfile.TemporaryDirectory(
            prefix="openvideo-summary-frames-"
        ) as temporary:
            paths = await asyncio.to_thread(
                extract_frames,
                playback,
                candidate_times,
                Path(temporary),
                self.settings.ffmpeg_path,
                self.settings.ffmpeg_bin_dir,
            )
            qualified = await asyncio.to_thread(
                filter_candidate_frames,
                paths,
                candidate_times,
            )
            self._record_metrics(
                job_id,
                frame_processing_ms=_elapsed_ms(phase_started),
            )
            if not qualified:
                self._skip_slot(job_id, slot_id, "候选画面均为黑屏、模糊或重复帧")
                return
            qualified = qualified[:7]
            self._update_slot(
                job_id,
                slot_id,
                status=SummaryIllustrationSlotStatus.VALIDATING,
                candidate_times=[frame.seconds for frame in qualified],
                source_excerpt=evidence.text[:2_000],
                source_types=[evidence.source_type],
                message="正在验证画面是否真正支持笔记",
            )
            self._update(
                job_id,
                stage=SummaryIllustrationStage.VALIDATING,
                message="正在验证候选画面",
            )
            phase_started = monotonic()
            decision = await self._validate_frames(job, slot, evidence, qualified)
            audit_decision = None
            vision_calls = 1
            if (
                decision.confidence == SummaryIllustrationConfidence.HIGH
                and decision.selected_index is not None
            ):
                selected = qualified[decision.selected_index - 1]
                audit_decision = await self._audit_selected_frame(
                    job,
                    slot,
                    evidence,
                    selected,
                )
                vision_calls += 1
            self._record_metrics(
                job_id,
                vision_ms=_elapsed_ms(phase_started),
                vision_calls=vision_calls,
            )
        if (
            decision.confidence != SummaryIllustrationConfidence.HIGH
            or decision.selected_index is None
        ):
            self._skip_slot(
                job_id,
                slot_id,
                f"视觉验证为{_confidence_label(decision.confidence)}置信度：{decision.reason}",
                confidence=decision.confidence,
            )
            return
        if (
            audit_decision is not None
            and (
                audit_decision.confidence != SummaryIllustrationConfidence.HIGH
                or audit_decision.selected_index is None
            )
        ):
            self._skip_slot(
                job_id,
                slot_id,
                "最终画面复核未通过："
                f"{_confidence_label(audit_decision.confidence)}置信度，"
                f"{audit_decision.reason}",
                confidence=audit_decision.confidence,
            )
            return
        selected = qualified[decision.selected_index - 1]
        latest_document = self.library.load_summary_document(slot.document_id)
        if (
            latest_document is None
            or latest_document.version_id != job.version_id
            or latest_document.markdown.count(slot.target_excerpt) != 1
        ):
            self._skip_slot(job_id, slot_id, "文档已修改，无法唯一确认原插入位置")
            return
        existing_media = self.library.load_summary_media(job.asset_id, job.version_id)
        if any(
            media.origin == SummaryMediaOrigin.AUTOMATIC
            and media.document_id == slot.document_id
            and media.source_excerpt == evidence.text[:2_000]
            for media in existing_media
        ):
            self._skip_slot(job_id, slot_id, "该证据已经配图")
            return
        artifact, _ = await asyncio.to_thread(
            self.summary_manager.create_media,
            SummaryMediaCreate(
                document_id=slot.document_id,
                expected_revision=latest_document.revision,
                media_type=SummaryMediaType.IMAGE,
                start_seconds=selected.seconds,
                insert_after=slot.target_excerpt,
                caption=slot.caption,
            ),
            SummaryMediaProvenance(
                target_heading_path=slot.heading_path,
                source_excerpt=evidence.text[:2_000],
                source_types=[evidence.source_type],
                candidate_times=[frame.seconds for frame in qualified],
                vision_model_id=job.vision_model_id,
                validation_confidence=decision.confidence,
                validation_summary=decision.reason,
            ),
        )
        self._update_slot(
            job_id,
            slot_id,
            status=SummaryIllustrationSlotStatus.INSERTED,
            selected_time=selected.seconds,
            confidence=decision.confidence,
            media_id=artifact.media_id,
            message="已插入高置信度画面",
        )
        job = self._require_job(job_id)
        self._update(job_id, inserted_count=job.inserted_count + 1)

    def _retrieve_evidence(
        self,
        job: SummaryIllustrationJob,
        slot: SummaryIllustrationSlot,
    ) -> IndexedEvidenceDocument | None:
        query_encoder = None
        reranker = None
        if self.retrieval_models is not None:
            status = self.library.agent_evidence_index_status()
            if status.state == "ready" and status.active_model is not None:
                query_encoder = self.retrieval_models.encode_query
                reranker = self.retrieval_models.rerank
        evidence = self.library.search_agent_evidence(
            asset_ids=[job.asset_id],
            query=slot.retrieval_query,
            start_seconds=None,
            end_seconds=None,
            limit=EVIDENCE_LIMIT,
            query_encoder=query_encoder,
            reranker=reranker,
        )
        markers = self.library.load_markers(job.asset_id)
        precise_evidence = [
            item for item in evidence if _is_temporally_precise(item)
        ]
        ranked = sorted(
            precise_evidence,
            key=lambda item: (
                -(
                    item.relevance_score
                    + _formal_marker_score(item, markers)
                    + _visual_source_bonus(item.source_type)
                ),
                item.start_seconds,
            ),
        )
        if ranked:
            return ranked[0]
        if (
            self.visual_index_service is None
            or self.visual_index_service.status().state != VisualIndexState.READY
        ):
            return None
        matches = self.visual_index_service.search(
            job.asset_id,
            slot.retrieval_query,
            limit=1,
        )
        if not matches:
            return None
        match = matches[0]
        source_text = f"视觉索引匹配画面：{slot.retrieval_query}"
        source_version = hashlib.sha256(
            f"{match.relative_path}:{match.seconds}".encode()
        ).hexdigest()
        return IndexedEvidenceDocument(
            document_id=f"visual-match-{source_version[:16]}",
            asset_id=match.asset_id,
            source_type=AgentEvidenceSource.VISUAL,
            source_version=source_version,
            source_position=0,
            start_seconds=max(0, match.seconds - 1),
            end_seconds=match.seconds + 1,
            title="视觉索引候选",
            text=source_text,
            relevance_score=min(1, max(0, (match.similarity + 1) / 2)),
            match_reasons=("SigLIP2 画面语义匹配",),
        )

    async def _validate_frames(
        self,
        job: SummaryIllustrationJob,
        slot: SummaryIllustrationSlot,
        evidence: IndexedEvidenceDocument,
        frames: list[QualifiedFrame],
    ) -> VisionFrameDecision:
        model = self.settings.ai_model(job.vision_model_id or "")
        if model is None or IMAGE_INPUT_MODALITY not in model.input_modalities:
            raise SummaryIllustrationError("视觉模型不可用")
        prompt = (
            "判断哪些候选画面能直接、清晰地证明笔记内容。图片顺序与候选时间顺序一致。"
            "必须逐项核对画面内可见文字、人物、产品、作品和场景；上下文或字幕不能替代"
            "像素证据。若图注中的命名实体或关键视觉主张未出现，或画面文字与其冲突，"
            "必须返回 medium/low 且 selected_index 为 null。只返回 JSON："
            '{"selected_index":1,"confidence":"high|medium|low",'
            '"reason":"..."}。若没有合适画面，selected_index 返回 null。'
            "只有主体清楚、不是过渡帧、与证据和图片说明明确一致时才可给 high；"
            "任何歧义都必须给 medium 或 low。reason 必须引用画面中实际可见的依据或冲突。\n\n"
            f"笔记位置：{' > '.join(slot.heading_path) or '正文'}\n"
            f"笔记原文：{slot.target_excerpt}\n"
            f"图片说明：{slot.caption}\n"
            f"视频证据：{evidence.text}\n"
            "候选时间："
            + json.dumps([frame.seconds for frame in frames], ensure_ascii=False)
        )
        try:
            content = await LiteLlmVision(model).describe_async(
                [frame.path for frame in frames],
                prompt,
            )
            decision = VisionFrameDecision.model_validate_json(_json_content(content))
        except (VisionDescriptionError, ValidationError, ValueError) as error:
            raise SummaryIllustrationError(f"视觉验证无效：{error}") from error
        if decision.selected_index is not None and decision.selected_index > len(
            frames
        ):
            raise SummaryIllustrationError("视觉模型选择了不存在的候选画面")
        return decision

    async def _audit_selected_frame(
        self,
        job: SummaryIllustrationJob,
        slot: SummaryIllustrationSlot,
        evidence: IndexedEvidenceDocument,
        frame: QualifiedFrame,
    ) -> VisionFrameDecision:
        """高置信度图片独立复核一次，避免上下文诱导模型忽略画面冲突。"""
        model = self.settings.ai_model(job.vision_model_id or "")
        if model is None or IMAGE_INPUT_MODALITY not in model.input_modalities:
            raise SummaryIllustrationError("视觉模型不可用")
        prompt = (
            "这是自动插图前的最终画面复核，只有一张图片。先只看像素中实际可见的"
            "标题、文字、对象和场景，再逐项对照图片说明。字幕仅用于定位，不能证明"
            "图片内容。若说明点名的作品、产品、人物、图表或概念未在画面中明确出现，"
            "或可见文字与说明冲突，必须返回 low/medium 和 null；不得根据课程上下文"
            "猜测。例如说明是 HoloLens/AR，而画面写着 Oculus/Virtual Reality，必须"
            "拒绝。仅当所有关键视觉主张都能由当前图片直接确认时，返回 high 和 1。"
            "只返回 JSON："
            '{"selected_index":1,"confidence":"high|medium|low",'
            '"reason":"引用可见证据或冲突"}。\n\n'
            f"笔记原文：{slot.target_excerpt}\n"
            f"图片说明：{slot.caption}\n"
            f"定位字幕：{evidence.text}\n"
            f"候选时间：{frame.seconds}"
        )
        try:
            content = await LiteLlmVision(model).describe_async([frame.path], prompt)
            decision = VisionFrameDecision.model_validate_json(_json_content(content))
        except (VisionDescriptionError, ValidationError, ValueError) as error:
            raise SummaryIllustrationError(f"最终画面复核无效：{error}") from error
        if decision.selected_index not in {None, 1}:
            raise SummaryIllustrationError("最终画面复核选择了不存在的候选画面")
        return decision

    def _vision_model_id(self) -> str | None:
        preferred = self.settings.agent.vision_model_id
        if preferred is not None:
            model = self.settings.ai_model(preferred)
            if model is not None and IMAGE_INPUT_MODALITY in model.input_modalities:
                return preferred
        profiles = {
            model.model_id: self.capability_resolver.resolve(model)
            for model in self.settings.online_ai_models
        }
        return select_automatic_model_id(
            AgentModelRole.VISION,
            self.settings.online_ai_models,
            profiles,
        )

    def _vision_model_error(self, model_id: str) -> str | None:
        model = self.settings.ai_model(model_id)
        if model is None or IMAGE_INPUT_MODALITY not in model.input_modalities:
            return "视觉模型不可用"
        api_key_digest = hashlib.sha256((model.api_key or "").encode()).hexdigest()
        cache_key = (
            model.model_id,
            model.litellm_model,
            model.api_base or "",
            model.api_version or "",
            api_key_digest,
        )
        with self._lock:
            if cache_key in self._vision_probe_errors:
                return self._vision_probe_errors[cache_key]
        try:
            probe_image_input(model, VISION_MODEL_PROBE_TIMEOUT_SECONDS)
        except LlmCompletionError as error:
            probe_error = str(error)
        else:
            probe_error = None
        with self._lock:
            self._vision_probe_errors[cache_key] = probe_error
        return probe_error

    def _skip_slot(
        self,
        job_id: str,
        slot_id: str,
        message: str,
        *,
        confidence: SummaryIllustrationConfidence | None = None,
    ) -> None:
        self._update_slot(
            job_id,
            slot_id,
            status=SummaryIllustrationSlotStatus.SKIPPED,
            confidence=confidence,
            message=message,
        )
        job = self._require_job(job_id)
        self._update(job_id, skipped_count=job.skipped_count + 1)

    def _update_slot(self, job_id: str, slot_id: str, **updates: object) -> None:
        job = self._require_job(job_id)
        slots = [
            slot.model_copy(update=updates) if slot.slot_id == slot_id else slot
            for slot in job.slots
        ]
        self._update(job_id, slots=slots)

    def _update(self, job_id: str, **updates: object) -> SummaryIllustrationJob:
        with self._lock:
            job = self._jobs[job_id]
            now = datetime.now(UTC)
            metrics = updates.get("metrics", job.metrics)
            stage = updates.get("stage", job.stage)
            if stage in TERMINAL_SUMMARY_ILLUSTRATION_STAGES:
                metrics = metrics.model_copy(
                    update={
                        "total_ms": max(
                            metrics.total_ms,
                            round((now - job.created_at).total_seconds() * 1_000),
                        )
                    }
                )
            updated = job.model_copy(
                update={**updates, "metrics": metrics, "updated_at": now},
            )
            self._jobs[job_id] = updated
        self.library.save_summary_illustration_job(updated)
        return updated.model_copy(deep=True)

    def _record_metrics(
        self,
        job_id: str,
        *,
        planning_ms: int = 0,
        retrieval_ms: int = 0,
        frame_processing_ms: int = 0,
        vision_ms: int = 0,
        vision_calls: int = 0,
    ) -> None:
        job = self._require_job(job_id)
        metrics = job.metrics.model_copy(
            update={
                "planning_ms": job.metrics.planning_ms + planning_ms,
                "retrieval_ms": job.metrics.retrieval_ms + retrieval_ms,
                "frame_processing_ms": (
                    job.metrics.frame_processing_ms + frame_processing_ms
                ),
                "vision_ms": job.metrics.vision_ms + vision_ms,
                "vision_calls": job.metrics.vision_calls + vision_calls,
            }
        )
        self._update(job_id, metrics=metrics)

    def _require_job(self, job_id: str) -> SummaryIllustrationJob:
        with self._lock:
            job = self._jobs.get(job_id)
        if job is None:
            raise SummaryIllustrationError("配图任务不存在")
        return job.model_copy(deep=True)


def _slot(job: SummaryIllustrationJob, slot_id: str) -> SummaryIllustrationSlot:
    slot = next((item for item in job.slots if item.slot_id == slot_id), None)
    if slot is None:
        raise SummaryIllustrationError("配图位置不存在")
    return slot


def _json_content(content: str) -> str:
    stripped = content.strip()
    if stripped.startswith("```") and stripped.endswith("```"):
        first_line_end = stripped.find("\n")
        if first_line_end >= 0:
            return stripped[first_line_end + 1 : -3].strip()
    return stripped


def _formal_marker_score(
    evidence: IndexedEvidenceDocument,
    markers: list[MediaMarker],
) -> float:
    importance = max(
        (
            marker.importance
            for marker in markers
            if evidence.end_seconds > marker.start_seconds
            and evidence.start_seconds
            < (marker.end_seconds or marker.start_seconds + 1)
        ),
        default=0,
    )
    return importance * FORMAL_MARKER_SCORE_PER_LEVEL


def _visual_source_bonus(source_type: AgentEvidenceSource) -> float:
    if source_type in {AgentEvidenceSource.VISUAL, AgentEvidenceSource.OCR}:
        return 0.08
    if source_type == AgentEvidenceSource.ANALYSIS:
        return 0.04
    return 0


def _is_temporally_precise(evidence: IndexedEvidenceDocument) -> bool:
    """过宽文本无法证明具体画面，应转入视觉索引而不是扫描长视频。"""
    duration_seconds = evidence.end_seconds - evidence.start_seconds
    return 0 <= duration_seconds <= MAXIMUM_DIRECT_EVIDENCE_WINDOW_SECONDS


def _evidence_window(
    evidence: IndexedEvidenceDocument,
    duration_seconds: float | None,
) -> tuple[float, float]:
    start_seconds = max(0, evidence.start_seconds - EVIDENCE_WINDOW_PADDING_SECONDS)
    end_seconds = evidence.end_seconds + EVIDENCE_WINDOW_PADDING_SECONDS
    if end_seconds - start_seconds < MINIMUM_EVIDENCE_WINDOW_SECONDS:
        missing = MINIMUM_EVIDENCE_WINDOW_SECONDS - (end_seconds - start_seconds)
        start_seconds = max(0, start_seconds - missing / 2)
        end_seconds += missing / 2
    if duration_seconds is not None:
        end_seconds = min(duration_seconds, end_seconds)
    return start_seconds, end_seconds


def _candidate_count(start_seconds: float, end_seconds: float) -> int:
    return min(7, max(3, round((end_seconds - start_seconds) / 4)))


def _confidence_label(confidence: SummaryIllustrationConfidence) -> str:
    return {
        SummaryIllustrationConfidence.HIGH: "高",
        SummaryIllustrationConfidence.MEDIUM: "中",
        SummaryIllustrationConfidence.LOW: "低",
    }[confidence]


def _elapsed_ms(started_at: float) -> int:
    return max(0, round((monotonic() - started_at) * 1_000))
