from __future__ import annotations

import json
import sqlite3

from openvideo.core.analysis_models import AnalysisJob
from openvideo.core.library_files import (
    ARTIFACTS_DIRECTORY_NAME,
    MARKERS_FILE_NAME,
    TIMELINE_FILE_NAME,
    TRANSCRIPTION_METADATA_FILE_NAME,
    MarkersFile,
    TimelineFile,
    atomic_write_model,
)
from openvideo.core.library_index import synchronize_asset
from openvideo.core.media_models import MediaMarker, MediaSegment
from openvideo.core.transcription_models import Transcript, TranscriptionMetadata


class LibraryAnalysisStorageMixin:
    """让转录、时间轴与标记的业务文件和可重建索引保持同步。"""

    def save_transcript(self, transcript: Transcript) -> None:
        self._validate_asset_id(transcript.asset_id)
        asset = self.get(transcript.asset_id)
        if asset is None:
            raise ValueError("转录对应的素材不存在")
        with self._lock:
            atomic_write_model(self._transcript_path(transcript.asset_id), transcript)
            self._write_asset_metadata(asset)
            synchronize_asset(self._db(), self.assets_path, transcript.asset_id)

    def save_transcription_metadata(self, metadata: TranscriptionMetadata) -> None:
        """任务详情需要独立于运行进程保存，便于失败诊断和结果追溯。"""
        asset = self.get(metadata.asset_id)
        if asset is None:
            raise ValueError("转录元数据对应的素材不存在")
        output_path = (
            self.artifacts_directory(metadata.asset_id)
            / TRANSCRIPTION_METADATA_FILE_NAME
        )
        with self._lock:
            atomic_write_model(output_path, metadata)
            self._write_asset_metadata(asset)
            synchronize_asset(self._db(), self.assets_path, metadata.asset_id)

    def load_transcription_metadata(
        self, asset_id: str
    ) -> TranscriptionMetadata | None:
        input_path = (
            self.asset_directory(asset_id)
            / ARTIFACTS_DIRECTORY_NAME
            / TRANSCRIPTION_METADATA_FILE_NAME
        )
        return self._load_optional_model(input_path, TranscriptionMetadata, asset_id)

    def load_transcript(self, asset_id: str) -> Transcript | None:
        return self._load_optional_model(
            self._transcript_path(asset_id), Transcript, asset_id
        )

    def save_segments(self, asset_id: str, segments: list[MediaSegment]) -> None:
        self._validate_asset_id(asset_id)
        if any(segment.asset_id != asset_id for segment in segments):
            raise ValueError("时间轴事件不属于同一个媒体素材")
        output = TimelineFile(asset_id=asset_id, segments=segments)
        output_path = self.artifacts_directory(asset_id) / TIMELINE_FILE_NAME
        with self._lock:
            atomic_write_model(output_path, output)
            synchronize_asset(self._db(), self.assets_path, asset_id)

    def load_segments(self, asset_id: str) -> list[MediaSegment]:
        rows = (
            self._db()
            .execute(
                "SELECT * FROM timeline_segments WHERE asset_id = ? ORDER BY position",
                (asset_id,),
            )
            .fetchall()
        )
        segments: list[MediaSegment] = []
        for row in rows:
            segment_id = row["segment_id"]
            values = dict(row)
            values.pop("position")
            values.update(
                key_frame_paths=self._relation_values(
                    "segment_frames",
                    "relative_path",
                    "segment_id",
                    segment_id,
                    "position",
                ),
                tags=self._relation_values(
                    "segment_tags", "tag_name", "segment_id", segment_id, "tag_name"
                ),
                marker_ids=self._relation_values(
                    "segment_markers",
                    "marker_id",
                    "segment_id",
                    segment_id,
                    "marker_id",
                ),
            )
            segments.append(MediaSegment.model_validate(values))
        return segments

    def save_analysis_job(self, job: AnalysisJob) -> None:
        values = job.model_dump(mode="json", exclude={"marker_ids", "capabilities"})
        values["proposed_segments"] = json.dumps(
            values["proposed_segments"], ensure_ascii=False
        )
        with self._lock, self._db():
            self._upsert_runtime_model("analysis_jobs", values, transaction=False)
            self._db().execute(
                "DELETE FROM analysis_job_markers WHERE job_id = ?", (job.job_id,)
            )
            self._db().execute(
                "DELETE FROM analysis_job_capabilities WHERE job_id = ?", (job.job_id,)
            )
            self._db().executemany(
                "INSERT INTO analysis_job_markers(job_id, marker_id) VALUES (?, ?)",
                [(job.job_id, value) for value in dict.fromkeys(job.marker_ids)],
            )
            self._db().executemany(
                "INSERT INTO analysis_job_capabilities(job_id, capability) "
                "VALUES (?, ?)",
                [
                    (job.job_id, value.value)
                    for value in dict.fromkeys(job.capabilities)
                ],
            )

    def load_analysis_jobs(self) -> list[AnalysisJob]:
        rows = (
            self._db()
            .execute("SELECT * FROM analysis_jobs ORDER BY created_at")
            .fetchall()
        )
        jobs: list[AnalysisJob] = []
        for row in rows:
            values = dict(row)
            values["strategy"] = json.loads(values["strategy"])
            values["proposed_segments"] = json.loads(values["proposed_segments"])
            values["marker_ids"] = self._relation_values(
                "analysis_job_markers",
                "marker_id",
                "job_id",
                row["job_id"],
                "marker_id",
            )
            values["capabilities"] = self._relation_values(
                "analysis_job_capabilities",
                "capability",
                "job_id",
                row["job_id"],
                "capability",
            )
            jobs.append(AnalysisJob.model_validate(values))
        return jobs

    def load_markers(self, asset_id: str) -> list[MediaMarker]:
        self._validate_asset_id(asset_id)
        rows = (
            self._db()
            .execute(
                "SELECT marker_id, asset_id, start_seconds, end_seconds, importance "
                "FROM markers "
                "WHERE asset_id = ? ORDER BY start_seconds",
                (asset_id,),
            )
            .fetchall()
        )
        return [MediaMarker(**dict(row)) for row in rows]

    def create_marker(self, marker: MediaMarker) -> MediaMarker:
        self._validate_identifier(marker.marker_id, "marker")
        if self.get(marker.asset_id) is None:
            raise ValueError("标记对应的素材不存在")
        markers = self.load_markers(marker.asset_id)
        if any(item.marker_id == marker.marker_id for item in markers):
            raise sqlite3.IntegrityError("标记标识已存在")
        markers.append(marker)
        self._write_markers(marker.asset_id, markers)
        return marker.model_copy(deep=True)

    def update_marker(
        self,
        asset_id: str,
        marker_id: str,
        *,
        changes: dict[str, object],
    ) -> MediaMarker | None:
        self._validate_identifier(marker_id, "marker")
        markers = self.load_markers(asset_id)
        marker = next((item for item in markers if item.marker_id == marker_id), None)
        if marker is None:
            return None
        updated = MediaMarker.model_validate(
            {
                **marker.model_dump(),
                **changes,
            }
        )
        self._write_markers(
            asset_id,
            [updated if item.marker_id == marker_id else item for item in markers],
        )
        return updated

    def replace_markers_and_segments(
        self,
        asset_id: str,
        markers: list[MediaMarker],
        segments: list[MediaSegment],
    ) -> None:
        """审批批次同时改写标记和事件引用，任一步失败都恢复原业务文件。"""
        self._validate_asset_id(asset_id)
        if any(marker.asset_id != asset_id for marker in markers):
            raise ValueError("标记不属于同一个媒体素材")
        if any(segment.asset_id != asset_id for segment in segments):
            raise ValueError("时间轴事件不属于同一个媒体素材")
        original_markers = self.load_markers(asset_id)
        original_segments = self.load_segments(asset_id)
        marker_path = self.asset_directory(asset_id) / MARKERS_FILE_NAME
        timeline_path = self.artifacts_directory(asset_id) / TIMELINE_FILE_NAME
        with self._lock:
            try:
                atomic_write_model(
                    marker_path,
                    MarkersFile(asset_id=asset_id, markers=markers),
                )
                atomic_write_model(
                    timeline_path,
                    TimelineFile(asset_id=asset_id, segments=segments),
                )
                synchronize_asset(self._db(), self.assets_path, asset_id)
            except Exception:
                atomic_write_model(
                    marker_path,
                    MarkersFile(asset_id=asset_id, markers=original_markers),
                )
                atomic_write_model(
                    timeline_path,
                    TimelineFile(asset_id=asset_id, segments=original_segments),
                )
                synchronize_asset(self._db(), self.assets_path, asset_id)
                raise

    def delete_marker(self, asset_id: str, marker_id: str) -> bool:
        self._validate_identifier(marker_id, "marker")
        markers = self.load_markers(asset_id)
        remaining = [item for item in markers if item.marker_id != marker_id]
        if len(remaining) == len(markers):
            return False
        segments = self.load_segments(asset_id)
        if any(marker_id in segment.marker_ids for segment in segments):
            raise sqlite3.IntegrityError("标记仍被时间轴引用")
        self._write_markers(asset_id, remaining)
        return True
