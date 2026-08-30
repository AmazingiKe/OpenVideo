from __future__ import annotations

import json
import sqlite3
from datetime import UTC, datetime

from openvideo.core.analysis_models import AnalysisJob
from openvideo.core.event_analysis_models import (
    EventAnalysesFile,
    EventAnalysis,
    EventAnalysisJob,
    EventAnalysisStatus,
    FocusSelection,
    build_event_analysis_source_summary,
    timeline_evidence_for_target,
    transcript_evidence_for_target,
)
from openvideo.core.library_files import (
    ARTIFACTS_DIRECTORY_NAME,
    EVENT_ANALYSES_FILE_NAME,
    FOCUS_SELECTION_FILE_NAME,
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
            self._mark_event_analyses_stale(transcript.asset_id)
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
            self._mark_event_analyses_stale(asset_id)
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
            values["formula_latex"] = json.loads(values["formula_latex"])
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
        values = job.model_dump(mode="json", exclude={"capabilities"})
        values["proposed_segments"] = json.dumps(
            values["proposed_segments"], ensure_ascii=False
        )
        with self._lock, self._db():
            self._upsert_runtime_model("analysis_jobs", values, transaction=False)
            self._db().execute(
                "DELETE FROM analysis_job_capabilities WHERE job_id = ?", (job.job_id,)
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
        with self._lock:
            self._write_markers(marker.asset_id, markers)
            synchronize_asset(self._db(), self.assets_path, marker.asset_id)
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
        with self._lock:
            self._write_markers(
                asset_id,
                [updated if item.marker_id == marker_id else item for item in markers],
            )
            self._mark_event_analyses_stale(asset_id, marker_id=marker_id)
            synchronize_asset(self._db(), self.assets_path, asset_id)
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
        original_event_analyses = self._event_analyses_file(asset_id)
        marker_path = self.asset_directory(asset_id) / MARKERS_FILE_NAME
        timeline_path = self.artifacts_directory(asset_id) / TIMELINE_FILE_NAME
        event_analyses_path = (
            self.artifacts_directory(asset_id) / EVENT_ANALYSES_FILE_NAME
        )
        event_analyses_existed = event_analyses_path.is_file()
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
                self._mark_event_analyses_stale(asset_id, force_all=True)
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
                if event_analyses_existed:
                    atomic_write_model(
                        event_analyses_path,
                        original_event_analyses,
                    )
                else:
                    event_analyses_path.unlink(missing_ok=True)
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
        with self._lock:
            self._write_markers(asset_id, remaining)
            self._mark_event_analyses_stale(asset_id, marker_id=marker_id)
            synchronize_asset(self._db(), self.assets_path, asset_id)
        return True

    def load_focus_selection(self, asset_id: str) -> FocusSelection | None:
        self._validate_asset_id(asset_id)
        path = self.artifacts_directory(asset_id) / FOCUS_SELECTION_FILE_NAME
        return self._load_optional_model(path, FocusSelection, asset_id)

    def save_focus_selection(self, selection: FocusSelection) -> FocusSelection:
        self._validate_identifier(selection.selection_id, "focus-selection")
        if self.get(selection.asset_id) is None:
            raise ValueError("焦点选区对应的素材不存在")
        path = self.artifacts_directory(selection.asset_id) / FOCUS_SELECTION_FILE_NAME
        with self._lock:
            atomic_write_model(path, selection)
            self._mark_event_analyses_stale(
                selection.asset_id,
                selection_id=selection.selection_id,
            )
            synchronize_asset(self._db(), self.assets_path, selection.asset_id)
        return selection.model_copy(deep=True)

    def delete_focus_selection(self, asset_id: str) -> bool:
        selection = self.load_focus_selection(asset_id)
        if selection is None:
            return False
        path = self.artifacts_directory(asset_id) / FOCUS_SELECTION_FILE_NAME
        with self._lock:
            path.unlink(missing_ok=True)
            self._mark_event_analyses_stale(
                asset_id,
                selection_id=selection.selection_id,
            )
            synchronize_asset(self._db(), self.assets_path, asset_id)
        return True

    def load_event_analyses(self, asset_id: str) -> list[EventAnalysis]:
        self._validate_asset_id(asset_id)
        rows = self._db().execute(
            "SELECT * FROM event_analyses WHERE asset_id = ? ORDER BY created_at DESC",
            (asset_id,),
        ).fetchall()
        analyses: list[EventAnalysis] = []
        for row in rows:
            values = dict(row)
            analysis_id = values.pop("event_analysis_id")
            target_source = values.pop("target_source")
            marker_id = values.pop("marker_id")
            selection_id = values.pop("selection_id")
            start_seconds = values.pop("start_seconds")
            end_seconds = values.pop("end_seconds")
            values["event_analysis_id"] = analysis_id
            values["target"] = {
                "source": target_source,
                "marker_id": marker_id,
                "selection_id": selection_id,
                "start_seconds": start_seconds,
                "end_seconds": end_seconds,
            }
            values["target"] = {
                key: value for key, value in values["target"].items() if value is not None
            }
            values["key_points"] = json.loads(values["key_points"])
            values["source_summary"] = json.loads(values["source_summary"])
            evidence_rows = self._db().execute(
                "SELECT start_seconds, end_seconds, text, source "
                "FROM event_analysis_evidence WHERE event_analysis_id = ? "
                "ORDER BY position",
                (analysis_id,),
            ).fetchall()
            values["evidence"] = [dict(evidence) for evidence in evidence_rows]
            analyses.append(EventAnalysis.model_validate(values))
        return analyses

    def append_event_analyses(
        self, asset_id: str, analyses: list[EventAnalysis]
    ) -> list[EventAnalysis]:
        self._validate_asset_id(asset_id)
        if any(analysis.asset_id != asset_id for analysis in analyses):
            raise ValueError("事件分析不属于同一个素材")
        existing = self._event_analyses_file(asset_id).analyses
        existing_ids = {analysis.event_analysis_id for analysis in existing}
        if any(analysis.event_analysis_id in existing_ids for analysis in analyses):
            raise sqlite3.IntegrityError("事件分析标识已存在")
        for analysis in analyses:
            self._validate_identifier(analysis.event_analysis_id, "event-analysis")
        output = EventAnalysesFile(asset_id=asset_id, analyses=[*existing, *analyses])
        path = self.artifacts_directory(asset_id) / EVENT_ANALYSES_FILE_NAME
        with self._lock:
            atomic_write_model(path, output)
            synchronize_asset(self._db(), self.assets_path, asset_id)
        return [analysis.model_copy(deep=True) for analysis in analyses]

    def delete_event_analysis(self, event_analysis_id: str) -> bool:
        self._validate_identifier(event_analysis_id, "event-analysis")
        row = self._db().execute(
            "SELECT asset_id FROM event_analyses WHERE event_analysis_id = ?",
            (event_analysis_id,),
        ).fetchone()
        if row is None:
            return False
        asset_id = row["asset_id"]
        file = self._event_analyses_file(asset_id)
        remaining = [
            analysis
            for analysis in file.analyses
            if analysis.event_analysis_id != event_analysis_id
        ]
        with self._lock:
            atomic_write_model(
                self.artifacts_directory(asset_id) / EVENT_ANALYSES_FILE_NAME,
                file.model_copy(update={"analyses": remaining}),
            )
            synchronize_asset(self._db(), self.assets_path, asset_id)
        return True

    def save_event_analysis_job(self, job: EventAnalysisJob) -> None:
        self._validate_identifier(job.job_id, "event-analysis-job")
        values = job.model_dump(
            mode="json",
            exclude={"targets", "result_ids"},
        )
        with self._lock, self._db():
            self._upsert_runtime_model("event_analysis_jobs", values, transaction=False)
            self._db().execute(
                "DELETE FROM event_analysis_job_targets WHERE job_id = ?", (job.job_id,)
            )
            self._db().execute(
                "DELETE FROM event_analysis_job_results WHERE job_id = ?", (job.job_id,)
            )
            self._db().executemany(
                "INSERT INTO event_analysis_job_targets "
                "(job_id, position, target) VALUES (?, ?, ?)",
                [
                    (
                        job.job_id,
                        position,
                        target.model_dump_json(),
                    )
                    for position, target in enumerate(job.targets)
                ],
            )
            self._db().executemany(
                "INSERT INTO event_analysis_job_results "
                "(job_id, position, event_analysis_id) VALUES (?, ?, ?)",
                [
                    (job.job_id, position, analysis_id)
                    for position, analysis_id in enumerate(job.result_ids)
                ],
            )

    def load_event_analysis_jobs(self) -> list[EventAnalysisJob]:
        rows = self._db().execute(
            "SELECT * FROM event_analysis_jobs ORDER BY created_at"
        ).fetchall()
        jobs: list[EventAnalysisJob] = []
        for row in rows:
            values = dict(row)
            values["targets"] = [
                json.loads(item["target"])
                for item in self._db().execute(
                    "SELECT target FROM event_analysis_job_targets "
                    "WHERE job_id = ? ORDER BY position",
                    (row["job_id"],),
                ).fetchall()
            ]
            values["result_ids"] = [
                item["event_analysis_id"]
                for item in self._db().execute(
                    "SELECT event_analysis_id FROM event_analysis_job_results "
                    "WHERE job_id = ? ORDER BY position",
                    (row["job_id"],),
                ).fetchall()
            ]
            jobs.append(EventAnalysisJob.model_validate(values))
        return jobs

    def _event_analyses_file(self, asset_id: str) -> EventAnalysesFile:
        path = self.artifacts_directory(asset_id) / EVENT_ANALYSES_FILE_NAME
        return self._load_optional_model(path, EventAnalysesFile, asset_id) or EventAnalysesFile(
            asset_id=asset_id
        )

    def _mark_event_analyses_stale(
        self,
        asset_id: str,
        *,
        marker_id: str | None = None,
        selection_id: str | None = None,
        force_all: bool = False,
    ) -> None:
        file = self._event_analyses_file(asset_id)
        now = datetime.now(UTC)
        changed = False
        analyses: list[EventAnalysis] = []
        compare_source_summary = (
            marker_id is None and selection_id is None and not force_all
        )
        transcript = self.load_transcript(asset_id) if compare_source_summary else None
        timeline = (
            self._load_optional_model(
                self.artifacts_directory(asset_id) / TIMELINE_FILE_NAME,
                TimelineFile,
                asset_id,
            )
            if compare_source_summary
            else None
        )
        for analysis in file.analyses:
            if force_all:
                target_matches = True
            elif marker_id is not None:
                target_matches = (
                    analysis.target.source == "marker"
                    and analysis.target.marker_id == marker_id
                )
            elif selection_id is not None:
                target_matches = (
                    analysis.target.source == "focus_selection"
                    and analysis.target.selection_id == selection_id
                )
            else:
                transcript_evidence = transcript_evidence_for_target(
                    analysis.target,
                    transcript.segments if transcript else [],
                )
                timeline_evidence = timeline_evidence_for_target(
                    analysis.target,
                    timeline.segments if timeline else [],
                )
                target_matches = (
                    build_event_analysis_source_summary(
                        analysis.target,
                        transcript_evidence,
                        timeline_evidence,
                    )
                    != analysis.source_summary
                )
            if target_matches and analysis.status == EventAnalysisStatus.VALID:
                analysis = analysis.model_copy(
                    update={"status": EventAnalysisStatus.STALE, "updated_at": now}
                )
                changed = True
            analyses.append(analysis)
        if changed:
            atomic_write_model(
                self.artifacts_directory(asset_id) / EVENT_ANALYSES_FILE_NAME,
                file.model_copy(update={"analyses": analyses}),
            )
