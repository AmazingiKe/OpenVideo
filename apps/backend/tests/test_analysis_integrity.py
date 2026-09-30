import hashlib
import json
from types import SimpleNamespace

import pytest

from openvideo.analysis_manager import (
    AnalysisError,
    AnalysisManager,
    AnalysisPrerequisiteError,
    _segment_digest,
)
from openvideo.core.ai_models import (
    AiModelConfiguration,
    IMAGE_INPUT_MODALITY,
    TEXT_INPUT_MODALITY,
)
from openvideo.core.analysis import TimelineMoment
from openvideo.core.analysis_models import (
    AnalysisCapability,
    AnalysisMode,
    AnalysisDepth,
    AnalysisOperation,
    AnalysisStage,
    AnalysisStrategy,
    VisualAnalysisCoverage,
)
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
    VisualAnalysisStatus,
)
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.settings import Settings
from openvideo.tools.vision import VisionDescriptionError


ASSET_ID = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
MODEL_ID = "model-01890f4c7a2b7cc298c4dc0c0c07398f"


@pytest.fixture
def manager(tmp_path):
    library_path = tmp_path / "library"
    library_path.mkdir()
    library = MediaLibrary.initialize_directory(library_path)
    asset_directory = library.asset_directory(ASSET_ID)
    asset_directory.mkdir(parents=True)
    (asset_directory / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=ASSET_ID,
            source_url="local://tutorial",
            source_platform=SourcePlatform.LOCAL,
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
            duration_seconds=30,
        )
    )
    library.save_transcript(
        Transcript(
            asset_id=ASSET_ID,
            segments=[
                TranscriptSegment(start_seconds=0, end_seconds=30, text="雾效节点教程")
            ],
        )
    )
    settings = Settings(
        library_path=library.library_path,
        models_directory=str(tmp_path / "models"),
        ai_models=[
            AiModelConfiguration(
                model_id=MODEL_ID,
                name="测试视觉模型",
                litellm_model="openai/test",
                input_modalities=[TEXT_INPUT_MODALITY, IMAGE_INPUT_MODALITY],
            )
        ],
    )
    yield AnalysisManager(
        library,
        settings,
        ocr_reader=lambda _: None,
        formula_reader=lambda _: [],
    )
    library.close()


def legacy_segment(**updates):
    return MediaSegment(
        segment_id="segment-01890f4c7a2b7cc298c4dc0c0c07398f",
        asset_id=ASSET_ID,
        start_seconds=0,
        end_seconds=30,
        transcript_text="原有字幕时间轴",
        **updates,
    )


@pytest.mark.parametrize("description", [None, "其他模型留下的画面描述"])
def test_requested_visual_model_is_not_satisfied_by_existing_timeline(
    manager, description
):
    manager.library.save_segments(
        ASSET_ID, [legacy_segment(visual_description=description)]
    )

    job = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, MODEL_ID, AnalysisStrategy(), force=False
    )

    assert job.stage == AnalysisStage.PENDING
    assert job.ai_model_id == MODEL_ID
    assert (
        manager.library.load_segments(ASSET_ID)[0].transcript_text == "原有字幕时间轴"
    )


def test_reused_legacy_timeline_reports_unknown_visual_coverage(manager):
    manager.library.save_segments(
        ASSET_ID,
        [
            legacy_segment(
                key_frame_paths=["artifacts/frame.jpg"], visual_description="旧描述"
            )
        ],
    )

    job = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, None, AnalysisStrategy(), force=False
    )

    assert job.stage == AnalysisStage.COMPLETE
    assert job.visual_coverage.unknown_segments == 1
    assert job.visual_coverage.sampled_segments == 0
    assert AnalysisCapability.KEY_FRAMES in job.capabilities
    assert "视觉状态无法核实" in job.message


@pytest.mark.parametrize("mismatch", ["operation", "model", "strategy"])
def test_different_active_job_does_not_satisfy_visual_request(manager, mismatch):
    job = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, MODEL_ID, AnalysisStrategy(), force=False
    )
    assert (
        manager.create_analysis(
            ASSET_ID, AnalysisMode.FULL, MODEL_ID, AnalysisStrategy(), force=False
        ).job_id
        == job.job_id
    )
    active = manager._jobs[job.job_id]
    if mismatch == "operation":
        active.operation = AnalysisOperation.INITIALIZATION
    elif mismatch == "model":
        active.ai_model_id = None
    else:
        active.strategy = AnalysisStrategy(depth=AnalysisDepth.DEEP)

    with pytest.raises(AnalysisPrerequisiteError, match="正在执行不同"):
        manager.create_analysis(
            ASSET_ID, AnalysisMode.FULL, MODEL_ID, AnalysisStrategy(), force=False
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("successful_segments", [0, 1, 3])
async def test_visual_failures_remain_visible_after_preview_approval_and_reload(
    manager, monkeypatch, successful_segments
):
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline.detect_scene_boundaries", lambda *_: []
    )
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline.build_global_semantic_chapters",
        lambda *_, **__: [],
    )
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline.select_timeline_moments",
        lambda *_: [
            TimelineMoment(
                start_seconds=index * 10,
                end_seconds=(index + 1) * 10,
                transcript_text="节点步骤",
            )
            for index in range(3)
        ],
    )
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline._extract_event_frames",
        lambda moment, media, directory, *_: [
            directory / f"{int(moment.start_seconds)}.jpg"
        ],
    )
    monkeypatch.setattr(
        "openvideo.tools.analysis_pipeline.summarize_chapter",
        lambda model, title, transcript, *_: transcript,
    )

    def describe(frames, _prompt):
        if int(frames[0].stem) // 10 >= successful_segments:
            raise VisionDescriptionError("供应商请求失败")
        return "可见的节点画面"

    monkeypatch.setattr(
        manager, "_describer", lambda _: SimpleNamespace(describe=describe)
    )
    job = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, MODEL_ID, AnalysisStrategy(), force=False
    )
    await manager._run(job.job_id)
    preview = manager.get(job.job_id)

    assert preview.stage == AnalysisStage.WAITING_FOR_APPROVAL
    assert preview.visual_coverage.total_segments == 3
    assert preview.visual_coverage.sampled_segments == successful_segments
    assert preview.visual_coverage.sampled_frame_count == successful_segments
    assert preview.visual_coverage.failed_segments == 3 - successful_segments
    assert (AnalysisCapability.VISUAL in preview.capabilities) == bool(
        successful_segments
    )
    assert all(
        segment.transcript_text == "节点步骤" for segment in preview.proposed_segments
    )
    assert manager.library.load_segments(ASSET_ID) == []
    assert "非逐帧理解" in preview.message
    if successful_segments < 3:
        assert f"{3 - successful_segments} 个事件视觉分析失败" in preview.message

    restored = AnalysisManager(manager.library, manager.settings)
    restored.restore()
    assert restored.get(job.job_id).visual_coverage == preview.visual_coverage
    completed = restored.approve_proposal(job.job_id)

    assert completed.stage == AnalysisStage.COMPLETE
    assert completed.visual_coverage == preview.visual_coverage
    assert "非逐帧理解" in completed.message
    if successful_segments < 3:
        assert "视觉分析失败" in completed.message
    saved = manager.library.load_segments(ASSET_ID)
    assert (
        sum(
            segment.visual_analysis_status == VisualAnalysisStatus.FAILED
            for segment in saved
        )
        == 3 - successful_segments
    )
    assert (
        manager.library.load_analysis_jobs()[0].visual_coverage
        == preview.visual_coverage
    )


def test_coverage_keeps_skipped_missing_frames_and_unknown_separate():
    segments = [
        legacy_segment(visual_analysis_status=status) for status in VisualAnalysisStatus
    ]

    coverage = VisualAnalysisCoverage.from_segments(segments)

    assert coverage.total_segments == 6
    assert coverage.sampled_segments == 1
    assert coverage.sampled_frame_count == 0
    assert coverage.skipped_segments == 1
    assert coverage.no_frames_segments == 1
    assert coverage.failed_segments == 1
    assert coverage.not_requested_segments == 1
    assert coverage.unknown_segments == 1


def test_old_database_adds_visual_fields_without_losing_pending_jobs(manager):
    library = manager.library
    job = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, MODEL_ID, AnalysisStrategy(), force=False
    )
    library.save_segments(ASSET_ID, [legacy_segment()])
    timeline_path = library.artifacts_directory(ASSET_ID) / "timeline.json"
    timeline = json.loads(timeline_path.read_text(encoding="utf-8"))
    del timeline["segments"][0]["visual_analysis_status"]
    timeline_path.write_text(json.dumps(timeline), encoding="utf-8")
    with library._db():
        library._db().execute("ALTER TABLE analysis_jobs DROP COLUMN visual_coverage")
        library._db().execute(
            "ALTER TABLE timeline_segments DROP COLUMN visual_analysis_status"
        )
        library._db().execute("CREATE TABLE migration_sentinel (value TEXT)")
        library._db().execute("INSERT INTO migration_sentinel VALUES ('preserved')")
    library.close()

    for _ in range(2):
        restored = MediaLibrary.open(library.library_path)
        try:
            saved = restored.load_analysis_jobs()[0]
            assert saved.job_id == job.job_id
            assert saved.stage == AnalysisStage.PENDING
            assert saved.visual_coverage is None
            assert (
                restored.load_segments(ASSET_ID)[0].visual_analysis_status
                == VisualAnalysisStatus.UNKNOWN
            )
            assert (
                restored._db()
                .execute("SELECT value FROM migration_sentinel")
                .fetchone()[0]
                == "preserved"
            )
            assert restored._db().execute("PRAGMA foreign_key_check").fetchall() == []
        finally:
            restored.close()


@pytest.mark.parametrize("edited_field", [None, "title", "transcript_text"])
def test_legacy_pending_proposal_checks_edits_and_reports_unknown_coverage(
    manager,
    edited_field,
):
    current = legacy_segment()
    manager.library.save_segments(ASSET_ID, [current])
    legacy_payload = [
        current.model_dump(mode="json", exclude={"visual_analysis_status"})
    ]
    legacy_digest = hashlib.sha256(
        json.dumps(legacy_payload, ensure_ascii=False, sort_keys=True).encode("utf-8")
    ).hexdigest()
    assert _segment_digest([current]) == legacy_digest
    assert (
        _segment_digest(
            [
                current.model_copy(
                    update={"visual_analysis_status": VisualAnalysisStatus.FAILED}
                )
            ]
        )
        != legacy_digest
    )
    job = manager.create_analysis(
        ASSET_ID, AnalysisMode.FULL, MODEL_ID, AnalysisStrategy(), force=False
    )
    job.stage = AnalysisStage.WAITING_FOR_APPROVAL
    job.proposal_base_digest = legacy_digest
    job.proposed_segments = [legacy_segment(visual_description="旧视觉产物")]
    manager.library.save_analysis_job(job)
    restored = AnalysisManager(manager.library, manager.settings)
    restored.restore()

    if edited_field is not None:
        manager.library.save_segments(
            ASSET_ID, [current.model_copy(update={edited_field: "用户的新编辑"})]
        )
        with pytest.raises(AnalysisError, match="时间轴已发生变化"):
            restored.approve_proposal(job.job_id)
        assert (
            manager.library.load_segments(ASSET_ID)[0].model_dump()[edited_field]
            == "用户的新编辑"
        )
        return

    approved = restored.approve_proposal(job.job_id)

    assert approved.stage == AnalysisStage.COMPLETE
    assert approved.visual_coverage.unknown_segments == 1
    assert "视觉状态无法核实" in approved.message
    assert (
        restored.library.load_analysis_jobs()[0].visual_coverage
        == approved.visual_coverage
    )
