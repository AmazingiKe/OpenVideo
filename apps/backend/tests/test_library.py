import json
import sqlite3
from pathlib import Path

import pytest

from openvideo.core.analysis_models import Transcript, TranscriptSegment
from openvideo.core.library import InvalidLibraryError, MediaLibrary
from openvideo.core.library_files import (
    SummaryConversationFile,
    atomic_write_model,
    conversation_file_path,
)
from openvideo.core.models import (
    DownloadJob,
    MediaAsset,
    MediaAssetStatus,
    MediaMarker,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.summary_files import (
    atomic_write_text,
    build_manifest,
    markdown_digest,
    write_manifest,
)
from openvideo.core.summary_models import (
    SummaryConversation,
    SummaryDocument,
    SummaryEditProposal,
    SummaryMediaArtifact,
    SummaryMessage,
    SummaryMessageRole,
)


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
SECOND_ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c073990"
MARKER_ID = "marker-01890f4c7a2b7cc298c4dc0c0c07398f"
SEGMENT_ID = "segment-01890f4c7a2b7cc298c4dc0c0c07398f"
DOCUMENT_ID = "document-01890f4c7a2b7cc298c4dc0c0c07398f"
CONVERSATION_ID = "conversation-01890f4c7a2b7cc298c4dc0c0c07398f"
MESSAGE_ID = "message-01890f4c7a2b7cc298c4dc0c0c07398f"
PROPOSAL_ID = "proposal-01890f4c7a2b7cc298c4dc0c0c07398f"
MEDIA_ID = "media-01890f4c7a2b7cc298c4dc0c0c07398f"
JOB_ID = "job-01890f4c7a2b7cc298c4dc0c0c07398f"


def _asset(asset_id: str = ASSET_ID, title: str = "测试视频") -> MediaAsset:
    return MediaAsset(
        asset_id=asset_id,
        source_url=f"https://example.com/{asset_id}",
        source_platform=SourcePlatform.YOUTUBE,
        source_video_id=asset_id,
        title=title,
        status=MediaAssetStatus.READY,
        playback_path="media/playback.mp4",
    )


def _save_asset(library: MediaLibrary, asset: MediaAsset) -> None:
    media_directory = library.media_directory(asset.asset_id)
    (media_directory / "playback.mp4").write_bytes(b"video")
    library.save(asset)


def _save_summary(library: MediaLibrary) -> None:
    markdown = "# 用户总结\n"
    document = SummaryDocument(
        document_id=DOCUMENT_ID,
        asset_id=ASSET_ID,
        title="用户总结",
        markdown=markdown,
        relative_path="index.md",
        content_digest=markdown_digest(markdown),
    )
    asset_directory = library.asset_directory(ASSET_ID)
    atomic_write_text(asset_directory / "summary" / "index.md", markdown)
    write_manifest(asset_directory, build_manifest(ASSET_ID, [document], []))
    library.create_summary_documents([document])
    conversation = SummaryConversation(
        conversation_id=CONVERSATION_ID,
        asset_id=ASSET_ID,
        root_document_id=DOCUMENT_ID,
        title="修改历史",
    )
    message = SummaryMessage(
            message_id=MESSAGE_ID,
            conversation_id=CONVERSATION_ID,
            role=SummaryMessageRole.USER,
            content="请精简正文",
    )
    proposal = SummaryEditProposal(
            proposal_id=PROPOSAL_ID,
            session_id=f"session-{CONVERSATION_ID.removeprefix('conversation-')}",
            document_id=DOCUMENT_ID,
            base_revision=1,
            proposed_markdown="# 精简总结\n",
            explanation="删去重复内容",
            diff="- 用户总结\n+ 精简总结",
            status="accepted",
    )
    atomic_write_model(
        conversation_file_path(asset_directory, CONVERSATION_ID),
        SummaryConversationFile(
            conversation=conversation,
            messages=[message],
            proposals=[proposal],
        ),
    )
    media_path = asset_directory / "summary" / "assets" / f"{MEDIA_ID}.jpg"
    media_path.parent.mkdir(parents=True, exist_ok=True)
    media_path.write_bytes(b"image")
    library.save_summary_media(
        SummaryMediaArtifact(
            media_id=MEDIA_ID,
            asset_id=ASSET_ID,
            document_id=DOCUMENT_ID,
            media_type="image",
            relative_path=f"summary/assets/{MEDIA_ID}.jpg",
            caption="关键画面",
            start_seconds=1,
        )
    )


def test_saves_complete_asset_metadata_and_recovers_ready_asset(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    asset = _asset()
    _save_asset(library, asset)

    metadata = json.loads(
        (library.asset_directory(ASSET_ID) / "meta.json").read_text(encoding="utf-8")
    )
    assert metadata["asset_id"] == ASSET_ID
    assert metadata["status"] == "ready"
    assert metadata["playback_path"] == "media/playback.mp4"
    assert metadata["source"]["platform"] == "youtube"

    library.close()
    recovered = MediaLibrary.open(tmp_path)
    loaded_asset = recovered.get(ASSET_ID)
    assert loaded_asset is not None
    assert recovered.response_for(loaded_asset).playback_url.endswith("/stream")
    recovered.close()


def test_deleting_sqlite_rebuilds_all_user_results(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, _asset())
    marker = MediaMarker(
        marker_id=MARKER_ID, asset_id=ASSET_ID, time_seconds=2, tags=["重点"]
    )
    library.create_marker(marker)
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            language="zh",
            segments=[TranscriptSegment(start_seconds=0, end_seconds=3, text="正文")],
        )
    )
    library.save_segments(
        ASSET_ID,
        [
            MediaSegment(
                segment_id=SEGMENT_ID,
                asset_id=ASSET_ID,
                start_seconds=0,
                end_seconds=3,
                title="第一段",
                marker_ids=[MARKER_ID],
                tags=["章节"],
            )
        ],
    )
    _save_summary(library)
    library.save_download_job(DownloadJob(job_id=JOB_ID, asset_id=ASSET_ID))
    library.close()

    (tmp_path / "openvideo.sqlite3").unlink()
    rebuilt = MediaLibrary.open(tmp_path)

    assert rebuilt.get(ASSET_ID).title == "测试视频"
    assert rebuilt.load_transcript(ASSET_ID).segments[0].text == "正文"
    assert rebuilt.load_segments(ASSET_ID)[0].marker_ids == [MARKER_ID]
    assert rebuilt.load_markers(ASSET_ID)[0].tags == ["重点"]
    assert rebuilt.load_summary_document(DOCUMENT_ID).markdown == "# 用户总结\n"
    session_id = f"session-{CONVERSATION_ID.removeprefix('conversation-')}"
    assert rebuilt.load_agent_events(session_id)[0].payload["content"] == "请精简正文"
    migrated_proposal = rebuilt.load_agent_summary_proposal(PROPOSAL_ID)
    assert migrated_proposal.explanation == "删去重复内容"
    assert migrated_proposal.status == "accepted"
    assert rebuilt.load_summary_media(ASSET_ID)[0].media_id == MEDIA_ID
    assert rebuilt.list_download_jobs() == []
    tables = {
        row[0]
        for row in rebuilt._db().execute(
            "SELECT name FROM sqlite_master WHERE type = 'table'"
        )
    }
    assert not {
        "summary_conversations",
        "summary_messages",
        "summary_agent_runs",
    } & tables
    assert rebuilt._db().execute("PRAGMA foreign_key_check").fetchall() == []
    rebuilt.close()


def test_schema_mismatch_rebuilds_projection_from_files(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, _asset(title="文件标题"))
    library.close()
    connection = sqlite3.connect(tmp_path / "openvideo.sqlite3")
    connection.execute("UPDATE assets SET title = '数据库伪造标题'")
    connection.execute("PRAGMA user_version = 9")
    connection.commit()
    connection.close()

    rebuilt = MediaLibrary.open(tmp_path)
    assert rebuilt.get(ASSET_ID).title == "文件标题"
    rebuilt.close()


def test_corrupt_asset_is_isolated_and_recovers_after_file_is_fixed(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, _asset())
    _save_asset(library, _asset(SECOND_ASSET_ID, "可用素材"))
    library.close()
    metadata_path = tmp_path / "assets" / ASSET_ID / "meta.json"
    valid_content = metadata_path.read_text(encoding="utf-8")
    metadata_path.write_text("{broken", encoding="utf-8")

    isolated = MediaLibrary.open(tmp_path)
    assert isolated.get(ASSET_ID) is None
    assert isolated.get(SECOND_ASSET_ID).title == "可用素材"
    issue = isolated.description.index_issues[0]
    assert issue.asset_id == ASSET_ID
    assert issue.relative_path.endswith("meta.json")
    assert str(tmp_path) not in issue.relative_path
    assert metadata_path.read_text(encoding="utf-8") == "{broken"
    isolated.close()

    metadata_path.write_text(valid_content, encoding="utf-8")
    recovered = MediaLibrary.open(tmp_path)
    assert recovered.get(ASSET_ID) is not None
    assert recovered.description.index_issues == []
    recovered.close()


def test_only_changed_asset_gets_new_index_timestamp(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, _asset())
    _save_asset(library, _asset(SECOND_ASSET_ID, "第二个素材"))
    before = dict(library._db().execute("SELECT asset_id, indexed_at FROM index_states"))
    library.close()
    metadata_path = tmp_path / "assets" / ASSET_ID / "meta.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["title"] = "外部标题"
    metadata_path.write_text(json.dumps(metadata, ensure_ascii=False), encoding="utf-8")

    reopened = MediaLibrary.open(tmp_path)
    after = dict(reopened._db().execute("SELECT asset_id, indexed_at FROM index_states"))
    assert reopened.get(ASSET_ID).title == "外部标题"
    assert after[SECOND_ASSET_ID] == before[SECOND_ASSET_ID]
    assert after[ASSET_ID] != before[ASSET_ID]
    reopened.close()


def test_business_file_survives_projection_update_failure(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, _asset())

    def fail_projection(*_args, **_kwargs):
        raise sqlite3.OperationalError("模拟索引写入失败")

    monkeypatch.setattr("openvideo.core.library.synchronize_asset", fail_projection)
    with pytest.raises(sqlite3.OperationalError, match="模拟索引写入失败"):
        library.save_segments(
            ASSET_ID,
            [
                MediaSegment(
                    segment_id=SEGMENT_ID,
                    asset_id=ASSET_ID,
                    start_seconds=0,
                    end_seconds=1,
                )
            ],
        )
    timeline_path = tmp_path / "assets" / ASSET_ID / "artifacts" / "timeline.json"
    assert timeline_path.is_file()
    monkeypatch.undo()
    library.close()

    repaired = MediaLibrary.open(tmp_path)
    assert repaired.load_segments(ASSET_ID)[0].segment_id == SEGMENT_ID
    repaired.close()


def test_path_traversal_and_invalid_asset_directory_are_reported(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, _asset())
    library.close()
    metadata_path = tmp_path / "assets" / ASSET_ID / "meta.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["playback_path"] = "../outside.mp4"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")
    (tmp_path / "assets" / "not-a-uuid").mkdir()

    opened = MediaLibrary.open(tmp_path)
    assert opened.get(ASSET_ID) is None
    assert {issue.code for issue in opened.description.index_issues} == {
        "invalid_asset_id",
        "unsafe_path",
    }
    opened.close()


def test_cross_asset_timeline_reference_is_isolated(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, _asset())
    library.save_segments(
        ASSET_ID,
        [
            MediaSegment(
                segment_id=SEGMENT_ID,
                asset_id=ASSET_ID,
                start_seconds=0,
                end_seconds=1,
            )
        ],
    )
    library.close()
    timeline_path = tmp_path / "assets" / ASSET_ID / "artifacts" / "timeline.json"
    timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
    timeline["segments"][0]["asset_id"] = SECOND_ASSET_ID
    timeline_path.write_text(json.dumps(timeline), encoding="utf-8")

    opened = MediaLibrary.open(tmp_path)
    assert opened.get(ASSET_ID) is None
    assert opened.description.index_issues[0].code == "cross_asset_reference"
    opened.close()


def test_symbolic_link_reference_is_rejected(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    _save_asset(library, _asset())
    library.close()
    outside_path = tmp_path / "outside.mp4"
    outside_path.write_bytes(b"outside")
    link_path = tmp_path / "assets" / ASSET_ID / "media" / "linked.mp4"
    try:
        link_path.symlink_to(outside_path)
    except OSError:
        pytest.skip("当前 Windows 环境不允许创建测试符号链接")
    metadata_path = tmp_path / "assets" / ASSET_ID / "meta.json"
    metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
    metadata["playback_path"] = "media/linked.mp4"
    metadata_path.write_text(json.dumps(metadata), encoding="utf-8")

    opened = MediaLibrary.open(tmp_path)
    assert opened.get(ASSET_ID) is None
    assert opened.description.index_issues[0].code == "unsafe_path"
    opened.close()


def test_v1_library_is_rejected_without_migration(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    library.close()
    manifest_path = tmp_path / "library.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    manifest["format_version"] = 1
    manifest_path.write_text(json.dumps(manifest), encoding="utf-8")

    with pytest.raises(InvalidLibraryError, match="格式版本 1 不受支持"):
        MediaLibrary.open(tmp_path)


def test_marks_interrupted_asset_as_failed_in_authoritative_metadata(tmp_path: Path):
    library = MediaLibrary.initialize_directory(tmp_path)
    asset = _asset()
    asset.status = MediaAssetStatus.DOWNLOADING
    _save_asset(library, asset)
    library.close()

    recovered = MediaLibrary.open(tmp_path)
    assert recovered.get(ASSET_ID).status == MediaAssetStatus.FAILED
    metadata = json.loads(
        (tmp_path / "assets" / ASSET_ID / "meta.json").read_text(encoding="utf-8")
    )
    assert metadata["status"] == "failed"
    recovered.close()
