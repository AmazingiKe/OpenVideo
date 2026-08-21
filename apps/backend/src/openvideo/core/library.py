from __future__ import annotations

import json
import os
from datetime import UTC, datetime
from pathlib import Path
from threading import RLock

from openvideo.core.analysis_models import AnalysisJob, Transcript
from openvideo.core.models import (
    MediaAsset,
    MediaAssetResponse,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.models import ThumbnailStoryboardResponse, ThumbnailStoryboardTile
from openvideo.core.thumbnails import ThumbnailStoryboard, build_thumbnail_tiles


METADATA_FILE_NAME = "metadata.json"
TRANSCRIPT_FILE_NAME = "transcript.json"
SEGMENTS_FILE_NAME = "segments.json"
ANALYSIS_JOB_FILE_NAME = ".analysis/job.json"
MARKERS_FILE_NAME = "markers.json"
PLAYBACK_ROUTE_TEMPLATE = "/api/media/assets/{asset_id}/stream"
THUMBNAIL_ROUTE_TEMPLATE = "/api/media/assets/{asset_id}/thumbnail"
SPRITE_ROUTE_TEMPLATE = "/api/media/assets/{asset_id}/thumbnail-sprite"


class MediaLibrary:
    """媒体清单与文件目录共同构成资源的持久化边界。"""

    def __init__(self, library_path: Path) -> None:
        self.library_path = library_path.resolve()
        self.videos_path = self.library_path / "videos"
        self._assets: dict[str, MediaAsset] = {}
        self._lock = RLock()

    def load(self) -> None:
        self.videos_path.mkdir(parents=True, exist_ok=True)
        loaded_assets: dict[str, MediaAsset] = {}
        for metadata_path in self.videos_path.glob(f"*/{METADATA_FILE_NAME}"):
            try:
                asset = MediaAsset.model_validate_json(
                    metadata_path.read_text(encoding="utf-8")
                )
            except (OSError, ValueError):
                continue
            if asset.status in {
                MediaAssetStatus.PENDING,
                MediaAssetStatus.DOWNLOADING,
                MediaAssetStatus.PROCESSING,
            }:
                asset.status = MediaAssetStatus.FAILED
                asset.error_message = "服务重启中断了上一次下载，请重新提交"
                asset.updated_at = datetime.now(UTC)
                self._write_asset(asset)
            loaded_assets[asset.asset_id] = asset
        with self._lock:
            self._assets = loaded_assets

    def save(self, asset: MediaAsset) -> None:
        asset.updated_at = datetime.now(UTC)
        self._write_asset(asset)
        with self._lock:
            self._assets[asset.asset_id] = asset.model_copy(deep=True)

    def get(self, asset_id: str) -> MediaAsset | None:
        with self._lock:
            asset = self._assets.get(asset_id)
            return asset.model_copy(deep=True) if asset else None

    def list(self) -> list[MediaAsset]:
        with self._lock:
            assets = [asset.model_copy(deep=True) for asset in self._assets.values()]
        return sorted(assets, key=lambda asset: asset.created_at, reverse=True)

    def find_by_source_video_id(
        self,
        platform: SourcePlatform,
        source_video_id: str,
    ) -> MediaAsset | None:
        normalized_id = source_video_id.casefold()
        with self._lock:
            for asset in self._assets.values():
                same_platform = asset.source_platform == platform
                same_video = (
                    asset.source_video_id is not None
                    and asset.source_video_id.casefold() == normalized_id
                )
                if same_platform and same_video:
                    return asset.model_copy(deep=True)
        return None

    def asset_directory(self, asset_id: str) -> Path:
        self._validate_asset_id(asset_id)
        directory = (self.videos_path / asset_id).resolve()
        if not directory.is_relative_to(self.videos_path):
            raise ValueError("资源目录越出了媒体库")
        return directory

    def resolve_asset_file(self, asset: MediaAsset, relative_path: str | None) -> Path | None:
        if not relative_path:
            return None
        asset_directory = self.asset_directory(asset.asset_id)
        candidate = (asset_directory / relative_path).resolve()
        if not candidate.is_relative_to(asset_directory):
            return None
        if not candidate.is_file() or candidate.is_symlink():
            return None
        return candidate

    def response_for(self, asset: MediaAsset) -> MediaAssetResponse:
        playback_file = self.resolve_asset_file(asset, asset.playback_path)
        thumbnail_file = self.resolve_asset_file(asset, asset.thumbnail_path)
        storyboard = self._storyboard_for(asset)
        return MediaAssetResponse(
            asset_id=asset.asset_id,
            source_url=asset.source_url,
            source_platform=asset.source_platform,
            source_video_id=asset.source_video_id,
            title=asset.title,
            author_name=asset.author_name,
            description=asset.description,
            duration_seconds=asset.duration_seconds,
            width=asset.width,
            height=asset.height,
            video_codec=asset.video_codec,
            audio_codec=asset.audio_codec,
            status=asset.status,
            error_message=asset.error_message,
            playback_url=(
                PLAYBACK_ROUTE_TEMPLATE.format(asset_id=asset.asset_id)
                if playback_file
                else None
            ),
            thumbnail_url=(
                THUMBNAIL_ROUTE_TEMPLATE.format(asset_id=asset.asset_id)
                if thumbnail_file
                else None
            ),
            thumbnail_storyboard=storyboard,
            created_at=asset.created_at,
            updated_at=asset.updated_at,
        )

    def _storyboard_for(self, asset: MediaAsset) -> ThumbnailStoryboardResponse | None:
        sprite_file = self.resolve_asset_file(asset, asset.thumbnail_sprite_path)
        if not sprite_file:
            return None
        if any(
            value is None
            for value in (
                asset.thumbnail_tile_width,
                asset.thumbnail_tile_height,
                asset.thumbnail_interval_seconds,
                asset.thumbnail_columns,
                asset.thumbnail_total_tiles,
            )
        ):
            return None
        storyboard = ThumbnailStoryboard(
            sprite_path=asset.thumbnail_sprite_path,
            tile_width=asset.thumbnail_tile_width,
            tile_height=asset.thumbnail_tile_height,
            interval_seconds=asset.thumbnail_interval_seconds,
            columns=asset.thumbnail_columns,
            total_tiles=asset.thumbnail_total_tiles,
        )
        tiles = [
            ThumbnailStoryboardTile(start_time=tile.start_time, x=tile.x, y=tile.y)
            for tile in build_thumbnail_tiles(storyboard)
        ]
        return ThumbnailStoryboardResponse(
            url=SPRITE_ROUTE_TEMPLATE.format(asset_id=asset.asset_id),
            tile_width=storyboard.tile_width,
            tile_height=storyboard.tile_height,
            tiles=tiles,
        )

    def save_transcript(self, transcript: Transcript) -> None:
        directory = self.asset_directory(transcript.asset_id)
        directory.mkdir(parents=True, exist_ok=True)
        transcript_path = directory / TRANSCRIPT_FILE_NAME
        temporary_path = directory / f"{TRANSCRIPT_FILE_NAME}.tmp"
        temporary_path.write_text(
            transcript.model_dump_json(indent=2),
            encoding="utf-8",
        )
        os.replace(temporary_path, transcript_path)

    def load_transcript(self, asset_id: str) -> Transcript | None:
        directory = self.asset_directory(asset_id)
        transcript_path = directory / TRANSCRIPT_FILE_NAME
        if not transcript_path.is_file():
            return None
        try:
            return Transcript.model_validate_json(transcript_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return None

    def save_segments(self, asset_id: str, segments: list[MediaSegment]) -> None:
        if any(segment.asset_id != asset_id for segment in segments):
            raise ValueError("时间轴事件不属于同一个媒体资源")
        directory = self.asset_directory(asset_id)
        directory.mkdir(parents=True, exist_ok=True)
        segments_path = directory / SEGMENTS_FILE_NAME
        temporary_path = directory / f"{SEGMENTS_FILE_NAME}.tmp"
        temporary_path.write_text(
            json.dumps([segment.model_dump() for segment in segments], ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary_path, segments_path)

    def save_analysis_job(self, job: AnalysisJob) -> None:
        job_path = self.asset_directory(job.asset_id) / ANALYSIS_JOB_FILE_NAME
        job_path.parent.mkdir(parents=True, exist_ok=True)
        temporary_path = job_path.with_suffix(".tmp")
        temporary_path.write_text(job.model_dump_json(indent=2), encoding="utf-8")
        os.replace(temporary_path, job_path)

    def load_analysis_jobs(self) -> list[AnalysisJob]:
        jobs: list[AnalysisJob] = []
        for asset in self.list():
            job_path = self.asset_directory(asset.asset_id) / ANALYSIS_JOB_FILE_NAME
            if not job_path.is_file():
                continue
            try:
                jobs.append(AnalysisJob.model_validate_json(job_path.read_text(encoding="utf-8")))
            except (OSError, ValueError):
                continue
        return jobs

    def load_segments(self, asset_id: str) -> list[MediaSegment]:
        directory = self.asset_directory(asset_id)
        segments_path = directory / SEGMENTS_FILE_NAME
        if not segments_path.is_file():
            return []
        try:
            payload = json.loads(segments_path.read_text(encoding="utf-8"))
            return [MediaSegment.model_validate(item) for item in payload]
        except (OSError, ValueError):
            return []

    def load_markers(self, asset_id: str) -> list[MediaMarker]:
        directory = self.asset_directory(asset_id)
        markers_path = directory / MARKERS_FILE_NAME
        if not markers_path.is_file():
            return []
        try:
            payload = json.loads(markers_path.read_text(encoding="utf-8"))
            markers = [MediaMarker.model_validate(item) for item in payload]
        except (OSError, ValueError):
            return []
        return sorted(markers, key=lambda marker: marker.time_seconds)

    def create_marker(self, marker: MediaMarker) -> MediaMarker:
        self._validate_marker_id(marker.marker_id)
        markers = self.load_markers(marker.asset_id)
        markers.append(marker)
        self._save_markers(marker.asset_id, markers)
        return marker.model_copy(deep=True)

    def update_marker_tags(
        self,
        asset_id: str,
        marker_id: str,
        tags: list[str],
    ) -> MediaMarker | None:
        self._validate_marker_id(marker_id)
        markers = self.load_markers(asset_id)
        updated_marker: MediaMarker | None = None
        updated_markers = []
        for marker in markers:
            if marker.marker_id == marker_id:
                updated_marker = marker.model_copy(update={"tags": tags})
                updated_markers.append(updated_marker)
            else:
                updated_markers.append(marker)
        if updated_marker is None:
            return None
        self._save_markers(asset_id, updated_markers)
        return updated_marker

    def delete_marker(self, asset_id: str, marker_id: str) -> bool:
        self._validate_marker_id(marker_id)
        markers = self.load_markers(asset_id)
        remaining_markers = [marker for marker in markers if marker.marker_id != marker_id]
        if len(remaining_markers) == len(markers):
            return False
        self._save_markers(asset_id, remaining_markers)
        return True

    def _write_asset(self, asset: MediaAsset) -> None:
        directory = self.asset_directory(asset.asset_id)
        directory.mkdir(parents=True, exist_ok=True)
        metadata_path = directory / METADATA_FILE_NAME
        temporary_path = directory / f"{METADATA_FILE_NAME}.tmp"
        payload = asset.model_dump_json(indent=2)
        temporary_path.write_text(payload, encoding="utf-8")
        os.replace(temporary_path, metadata_path)

    def _save_markers(self, asset_id: str, markers: list[MediaMarker]) -> None:
        directory = self.asset_directory(asset_id)
        directory.mkdir(parents=True, exist_ok=True)
        markers_path = directory / MARKERS_FILE_NAME
        temporary_path = directory / f"{MARKERS_FILE_NAME}.tmp"
        sorted_markers = sorted(markers, key=lambda marker: marker.time_seconds)
        temporary_path.write_text(
            json.dumps(
                [marker.model_dump() for marker in sorted_markers],
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
        os.replace(temporary_path, markers_path)

    @staticmethod
    def _validate_asset_id(asset_id: str) -> None:
        if not asset_id.startswith("asset-"):
            raise ValueError("资源 ID 无效")
        suffix = asset_id.removeprefix("asset-")
        if len(suffix) != 32 or any(character not in "0123456789abcdef" for character in suffix):
            raise ValueError("资源 ID 无效")

    @staticmethod
    def _validate_marker_id(marker_id: str) -> None:
        if not marker_id.startswith("marker-"):
            raise ValueError("标记 ID 无效")
        suffix = marker_id.removeprefix("marker-")
        if len(suffix) != 32 or any(character not in "0123456789abcdef" for character in suffix):
            raise ValueError("标记 ID 无效")
