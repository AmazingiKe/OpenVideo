"""章节边界、标题与摘要必须来自同一组完整证据。"""

import json
from pathlib import Path

import pytest

from openvideo.core.analysis import (
    SemanticChapter,
    merge_semantic_chapter_candidates,
    select_timeline_moments,
)
from openvideo.core.analysis_models import AnalysisStrategy
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.settings import Settings
from openvideo.tools import chapters, analysis_pipeline
from openvideo.tools.llm import LlmCompletionError


def transcript():
    return Transcript(
        asset_id="asset-test",
        segments=[
            TranscriptSegment(
                start_seconds=2, end_seconds=12, text="先说明抽象数据类型的操作约定。"
            ),
            TranscriptSegment(
                start_seconds=15, end_seconds=25, text="接着使用链表实现同一个接口。"
            ),
        ],
    )


def test_semantic_title_survives_priority_and_marker_processing():
    moments = select_timeline_moments(
        transcript(),
        [],
        30,
        semantic_chapters=[SemanticChapter(0, 1, "抽象接口与链表实现")],
    )
    assert moments[0].title == "抽象接口与链表实现"


def test_out_of_order_window_candidates_keep_the_first_chapter_title():
    result = merge_semantic_chapter_candidates(
        4, [SemanticChapter(2, 3, "实现"), SemanticChapter(0, 1, "定义")]
    )
    assert [chapter.title for chapter in result] == ["定义", "实现"]


def test_overlapping_windows_remove_artificial_starts_and_merge_continuing_topics(
    monkeypatch,
):
    source = [
        TranscriptSegment(
            start_seconds=index, end_seconds=index + 1, text=f"接口说明 {index}"
        )
        for index in range(5)
    ]
    monkeypatch.setattr(
        chapters, "_overlapping_windows", lambda _segments: [(0, 3), (2, 5)]
    )
    responses = iter(
        [
            '{"chapters":[{"start_index":0,"end_index":0,"title":"开场"},{"start_index":1,"end_index":2,"title":"接口定义"}]}',
            '{"chapters":[{"start_index":2,"end_index":2,"title":"窗口开头"},{"start_index":3,"end_index":4,"title":"接口实现"}]}',
            '{"separate":true,"title":"开场与接口"}',
            '{"separate":false,"title":"接口定义与实现"}',
        ]
    )
    monkeypatch.setattr(
        chapters, "complete_text", lambda *_args, **_kwargs: next(responses)
    )
    result = chapters.build_global_semantic_chapters(source, model=object())
    assert result == [
        SemanticChapter(0, 0, "开场"),
        SemanticChapter(1, 4, "接口定义与实现"),
    ]


def test_pipeline_refines_speech_candidates_with_timestamped_frames(
    monkeypatch, tmp_path
):
    monkeypatch.setattr(analysis_pipeline, "detect_scene_boundaries", lambda *_args: [])
    monkeypatch.setattr(analysis_pipeline, "_extract_event_frames", lambda *_args: [])
    monkeypatch.setattr(
        analysis_pipeline,
        "extract_frames",
        lambda *_args: [tmp_path / "first.jpg", tmp_path / "second.jpg"],
    )
    observations = []

    def identify(_segments, _model, **kwargs):
        if "visual_evidence" in kwargs:
            observations.extend(kwargs["visual_evidence"])
            return [SemanticChapter(0, 1, "接口与实现")]
        return [SemanticChapter(0, 0, "接口"), SemanticChapter(1, 1, "实现")]

    monkeypatch.setattr(analysis_pipeline, "build_global_semantic_chapters", identify)
    monkeypatch.setattr(
        analysis_pipeline, "summarize_chapter", lambda *_args: "接口与实现的关系。"
    )
    result = analysis_pipeline.build_segments(
        transcript(),
        tmp_path / "video.mp4",
        "asset-test",
        tmp_path,
        30,
        Settings(),
        None,
        [],
        AnalysisStrategy(),
        lambda *_args: None,
        chapter_model=object(),
        ocr_reader=lambda frames: frames[0].name,
    )
    assert [(item.seconds, item.text) for item in observations] == [
        (2, "OCR：first.jpg"),
        (15, "OCR：second.jpg"),
    ]
    assert [item.title for item in result] == ["接口与实现"]


@pytest.mark.parametrize(
    "prediction",
    [
        [],
        [{"start_index": 0, "end_index": 0, "title": "遗漏结尾"}],
        [{"start_index": 1, "end_index": 1, "title": "遗漏开头"}],
        [
            {"start_index": 0, "end_index": 1, "title": "前章"},
            {"start_index": 1, "end_index": 1, "title": "重叠"},
        ],
        [{"start_index": 0, "end_index": 2, "title": "越界"}],
        [{"start_index": 0.5, "end_index": 1, "title": "小数"}],
        [{"start_index": True, "end_index": 1, "title": "布尔值"}],
        [{"start_index": 0, "end_index": 1, "title": "  "}],
    ],
)
def test_invalid_model_boundaries_fail_instead_of_becoming_local_chapters(
    prediction, monkeypatch
):
    monkeypatch.setattr(
        chapters,
        "complete_text",
        lambda *_args, **_kwargs: json.dumps({"chapters": prediction}),
    )
    with pytest.raises(LlmCompletionError):
        chapters.build_global_semantic_chapters(transcript().segments, model=object())


def test_visual_observations_keep_timestamps_and_do_not_replace_speech(monkeypatch):
    requests = []

    def complete(_model, messages, *_args, **_kwargs):
        requests.append(messages[0]["content"])
        return '{"chapters":[{"start_index":0,"end_index":1,"title":"数据结构"}]}'

    monkeypatch.setattr(chapters, "complete_text", complete)
    chapters.build_global_semantic_chapters(
        transcript().segments,
        model=object(),
        visual_evidence=[
            chapters.ChapterVisualEvidence(15, "画面标题：链表"),
            chapters.ChapterVisualEvidence(100, "其它时间的画面"),
        ],
    )
    assert "15.000 秒：画面标题：链表" in requests[0]
    assert transcript().segments[-1].text in requests[0]
    assert "其它时间的画面" not in requests[0]


def test_long_summary_includes_tail_ocr_and_visual_evidence(monkeypatch):
    requests = []

    def complete(_model, messages, *_args, **_kwargs):
        requests.append(messages[0]["content"])
        return '{"summary":"本章说明链表操作及其限制。"}'

    monkeypatch.setattr(chapters, "complete_text", complete)
    text = (
        "过程。" * chapters.CHAPTER_SUMMARY_INPUT_CHARACTERS
        + "最后结论：删除节点需要更新前驱。"
    )
    result = chapters.summarize_chapter(
        object(), "链表", text, "OCR：前驱节点", "指针指向后继"
    )
    assert result == "本章说明链表操作及其限制。"
    assert any("最后结论：删除节点需要更新前驱。" in request for request in requests)
    assert any(
        "OCR：前驱节点" in request and "指针指向后继" in request for request in requests
    )
    assert len(requests) > 1


def test_model_failure_is_not_silently_replaced_with_fixed_length_chapters(monkeypatch):
    def fail(*_args, **_kwargs):
        raise LlmCompletionError("模型不可用")

    monkeypatch.setattr(chapters, "complete_text", fail)
    with pytest.raises(LlmCompletionError, match="模型不可用"):
        chapters.build_global_semantic_chapters(transcript().segments, model=object())


def test_final_segments_preserve_titles_and_cover_the_video_without_gaps(
    monkeypatch, tmp_path: Path
):
    monkeypatch.setattr(analysis_pipeline, "detect_scene_boundaries", lambda *_args: [])
    monkeypatch.setattr(analysis_pipeline, "_extract_event_frames", lambda *_args: [])
    monkeypatch.setattr(
        analysis_pipeline,
        "build_global_semantic_chapters",
        lambda *_args, **_kwargs: [
            SemanticChapter(0, 0, "抽象接口"),
            SemanticChapter(1, 1, "链表实现"),
        ],
    )
    summarized = []

    def summarize(_model, title, text, *_args):
        summarized.append((title, text))
        return f"{title}的摘要"

    monkeypatch.setattr(analysis_pipeline, "summarize_chapter", summarize)
    result = analysis_pipeline.build_segments(
        transcript(),
        tmp_path / "video.mp4",
        "asset-test",
        tmp_path,
        30,
        Settings(),
        None,
        [],
        AnalysisStrategy(),
        lambda *_args: None,
        chapter_model=object(),
    )
    assert [(item.start_seconds, item.end_seconds) for item in result] == [
        (0, 15),
        (15, 30),
    ]
    assert [item.title for item in result] == ["抽象接口", "链表实现"]
    assert [item.detailed_summary for item in result] == [
        "抽象接口的摘要",
        "链表实现的摘要",
    ]
    assert summarized[1][1] == transcript().segments[1].text


def test_offline_evidence_does_not_claim_transcript_is_a_summary(monkeypatch, tmp_path):
    monkeypatch.setattr(analysis_pipeline, "detect_scene_boundaries", lambda *_args: [])
    monkeypatch.setattr(analysis_pipeline, "_extract_event_frames", lambda *_args: [])
    result = analysis_pipeline.build_segments(
        transcript(),
        tmp_path / "video.mp4",
        "asset-test",
        tmp_path,
        30,
        Settings(),
        None,
        [],
        AnalysisStrategy(),
        lambda *_args: None,
    )
    assert result[0].transcript_text
    assert result[0].detailed_summary is None


def test_summary_is_checked_against_original_evidence_before_returning(monkeypatch):
    requests = []

    def complete(_model, messages, *_args, **_kwargs):
        requests.append([dict(message) for message in messages])
        summary = (
            "错误的两个概念" if len(requests) == 1 else "数学逻辑模型就是抽象视图。"
        )
        return json.dumps({"summary": summary})

    monkeypatch.setattr(chapters, "complete_text", complete)
    source = "从数学逻辑模型的角度理解，也就是它的抽象视图。"
    result = chapters.summarize_chapter(object(), "抽象视图", source, None, None)
    assert result == "数学逻辑模型就是抽象视图。"
    assert source in requests[1][0]["content"]
    assert requests[1][1]["content"] == "错误的两个概念"


@pytest.fixture
def chapter_manager(tmp_path):
    from openvideo.analysis_manager import AnalysisManager
    from openvideo.core.ai_models import AiModelConfiguration
    from openvideo.core.library import MediaLibrary
    from openvideo.core.media_models import (
        MediaAsset,
        MediaAssetStatus,
        MediaSegment,
        SourcePlatform,
    )

    asset_id = "01890f4c-7a2b-7cc2-98c4-dc0c0c07398f"
    library = MediaLibrary.initialize_directory(tmp_path)
    directory = library.asset_directory(asset_id)
    directory.mkdir(parents=True, exist_ok=True)
    (directory / "playback.mp4").write_bytes(b"video")
    library.save(
        MediaAsset(
            asset_id=asset_id,
            source_url="https://example.com/video",
            source_platform=SourcePlatform.BILIBILI,
            title="章节测试",
            status=MediaAssetStatus.READY,
            playback_path="playback.mp4",
            duration_seconds=30,
        )
    )
    source = transcript().model_copy(update={"asset_id": asset_id})
    library.save_transcript(source)
    old = MediaSegment(
        segment_id="segment-01890f4c7a2b7cc298c4dc0c0c07398f",
        asset_id=asset_id,
        start_seconds=0,
        end_seconds=30,
        title="旧章节",
    )
    library.save_segments(asset_id, [old])
    model = AiModelConfiguration(
        name="文本模型", litellm_model="openai/test", api_key="test"
    )
    manager = AnalysisManager(
        library,
        Settings(ai_models=[model]),
        ocr_reader=lambda _frames: None,
        formula_reader=lambda _frames: [],
    )
    yield manager, asset_id, old
    library.close()


@pytest.mark.asyncio
async def test_chapter_job_accepts_text_model_and_saves_only_complete_results(
    chapter_manager, monkeypatch
):
    from openvideo.core.analysis_models import AnalysisStage

    manager, asset_id, old = chapter_manager

    def generate(*args):
        assert args[6] is None
        assert args[10].name == "文本模型"
        return [
            old.model_copy(
                update={
                    "title": "抽象接口与实现",
                    "detailed_summary": "接口与实现分离。",
                }
            )
        ]

    monkeypatch.setattr("openvideo.analysis_manager.build_segments", generate)
    job = manager.create_chapters(asset_id)
    assert manager.create_chapters(asset_id).job_id == job.job_id
    await manager._run(job.job_id)
    assert manager.get(job.job_id).stage == AnalysisStage.COMPLETE
    assert manager.library.load_segments(asset_id)[0].title == "抽象接口与实现"


@pytest.mark.asyncio
@pytest.mark.parametrize("conflict", [False, True])
async def test_failed_or_stale_chapter_generation_preserves_existing_results(
    chapter_manager, monkeypatch, conflict
):
    from openvideo.core.analysis_models import AnalysisStage

    manager, asset_id, old = chapter_manager

    def generate(*_args):
        if conflict:
            changed = manager.library.load_transcript(asset_id)
            changed.segments[0].text = "生成期间被修改的证据"
            manager.library.save_transcript(changed)
            return [old.model_copy(update={"title": "过期结果"})]
        raise LlmCompletionError("摘要生成失败")

    monkeypatch.setattr("openvideo.analysis_manager.build_segments", generate)
    job = manager.create_chapters(asset_id)
    await manager._run(job.job_id)
    assert manager.get(job.job_id).stage == AnalysisStage.FAILED
    assert manager.library.load_segments(asset_id)[0].title == "旧章节"


@pytest.mark.parametrize("has_transcript", [False, True])
def test_chapter_endpoint_requires_transcript_and_starts_background_job(
    chapter_manager, monkeypatch, has_transcript
):
    from fastapi import FastAPI
    from fastapi.testclient import TestClient
    from openvideo.ui.analysis_routes import register_analysis_routes

    manager, asset_id, old = chapter_manager
    if not has_transcript:
        manager.library.save_transcript(Transcript(asset_id=asset_id, segments=[]))
    started = []
    monkeypatch.setattr(manager, "start", started.append)
    app = FastAPI()
    register_analysis_routes(
        app, lambda: manager.library, lambda: manager, manager.settings
    )
    with TestClient(app) as client:
        response = client.post(f"/api/media/assets/{asset_id}/chapters")
    if has_transcript:
        assert response.status_code == 202
        assert response.json()["operation"] == "chapters"
        assert started == [response.json()["job_id"]]
    else:
        assert response.status_code == 409
        assert not started
    assert manager.library.load_segments(asset_id)[0].title == old.title
