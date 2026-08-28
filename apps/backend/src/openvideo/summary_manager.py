from __future__ import annotations

import io
import json
import re
import zipfile
from datetime import UTC, datetime
from pathlib import Path

from openvideo.core.transcription_models import TranscriptSegment
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAssetStatus, MediaSegment
from openvideo.core.summary_models import (
    SummaryDocument,
    SummaryDocumentCreate,
    SummaryDocumentUpdate,
    SummaryExportResult,
    SummaryGenerationRequest,
    SummaryMediaArtifact,
    SummaryMediaCreate,
    SummaryMediaType,
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
from openvideo.tools.llm import LlmCompletionError, complete_text
from openvideo.tools.summary_media import (
    GIF_DEFAULT_DURATION_SECONDS,
    SummaryMediaError,
    generate_summary_media,
)


SUMMARY_AGENT_TIMEOUT_SECONDS = 120
SUMMARY_AGENT_MAX_TOKENS = 12_000
SUMMARY_GENERATION_CONTEXT_LIMIT = 30_000
EXPORT_FILE_NAME_TIME_FORMAT = "%Y%m%d-%H%M%S-%f"


class SummaryError(RuntimeError):
    """总结工作台请求无法在当前资料库状态下完成。"""


class SummaryNotFoundError(SummaryError):
    """请求引用的总结资源不存在或不属于当前视频。"""


class SummaryRevisionConflictError(SummaryError):
    """文档已被更新，调用方必须读取新版本后再决定如何合并。"""


class SummaryManager:
    """维护总结文档、媒体与导出的版本和路径不变量。"""

    def __init__(self, library: MediaLibrary, settings: Settings) -> None:
        self.library = library
        self.settings = settings
        for asset in self.library.list():
            if self.library.load_summary_documents(asset.asset_id):
                self._documents(asset.asset_id)

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
            child_sources = (
                generated_children
                if model is not None
                else [
                    SummaryDocumentCreate(
                        title=segment.title,
                        markdown=self._segment_markdown(segment, request.detail.value),
                    )
                    for segment in segments
                    if _segment_summary(segment) is not None
                ]
            )
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

    def create_media(
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
            generate_summary_media(
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
            lines.append("尚无时间轴分析结果，可在标记页完成内容分析后再补充。")
        for segment in segments:
            timestamp = _timestamp(segment.start_seconds)
            summary = _segment_summary(segment) or "该片段暂无文字说明。"
            if detail == "concise":
                summary = summary[:180]
            lines.extend((f"### [{timestamp}] {segment.title}", "", summary, ""))
        return "\n".join(lines).strip() + "\n"

    @staticmethod
    def _segment_markdown(segment: MediaSegment, detail: str) -> str:
        summary = _segment_summary(segment) or "该片段暂无文字说明。"
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
            "仅当内容形成多个可独立阅读的章节时返回一级子文档；"
            "每项必须包含 title 和有实际正文的完整 markdown，不得只返回标题。"
            "内容不足或不适合拆分时，subdocuments 必须返回空数组。"
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


def _segment_summary(segment: MediaSegment) -> str | None:
    for content in (segment.detailed_summary, segment.transcript_text):
        if content and content.strip():
            return content.strip()
    return None


def _strip_code_fence(content: str) -> str:
    match = re.fullmatch(
        r"```(?:markdown|md|json)?\s*\n(?P<body>.*)\n```",
        content,
        re.DOTALL,
    )
    return match.group("body") if match else content


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
    subdocuments = _parse_subdocuments(payload.get("subdocuments"))
    return title.strip() if title else None, markdown + "\n", subdocuments


def _parse_subdocuments(value: object) -> list[SummaryDocumentCreate]:
    if not isinstance(value, list):
        return []
    subdocuments: list[SummaryDocumentCreate] = []
    for item in value:
        if not isinstance(item, dict):
            continue
        try:
            subdocument = SummaryDocumentCreate.model_validate(item)
        except ValueError:
            continue
        title = subdocument.title.strip()
        markdown = subdocument.markdown.strip()
        if not title or not _has_markdown_body(markdown):
            continue
        subdocuments.append(
            subdocument.model_copy(update={"title": title, "markdown": f"{markdown}\n"})
        )
    return subdocuments


def _has_markdown_body(markdown: str) -> bool:
    return any(
        line and not re.match(r"^#{1,6}(?:\s|$)", line)
        for line in (item.strip() for item in markdown.splitlines())
    )


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
