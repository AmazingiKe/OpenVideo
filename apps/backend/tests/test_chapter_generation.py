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


INTERFACE_OUTLINE = {
    "structure_summary": "全文围绕抽象接口与具体实现的关系展开，构成一个完整主题。",
    "chapters": [
        {
            "title": "抽象接口与实现",
            "content_summary": "通过链表说明操作约定与具体实现的关系。",
            "boundary_reason": "全部内容围绕接口和实现的关系展开。",
        }
    ],
}
INTERFACE_BOUNDARIES = {"chapters": [{"start_index": 0, "end_index": 1}]}


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


def content_understanding(start_index, end_index, content):
    return json.dumps(
        {
            "summary": content,
            "progression": [
                {"start_index": start_index, "end_index": end_index, "content": content}
            ],
        },
        ensure_ascii=False,
    )


def test_semantic_title_survives_priority_and_marker_processing():
    moments = select_timeline_moments(
        transcript(),
        [],
        30,
        semantic_chapters=[
            SemanticChapter(
                0, 1, "抽象接口与链表实现", "通过链表说明接口与实现的关系。"
            )
        ],
    )
    assert moments[0].title == "抽象接口与链表实现"
    assert moments[0].content_summary == "通过链表说明接口与实现的关系。"


def test_out_of_order_window_candidates_keep_the_first_chapter_title():
    result = merge_semantic_chapter_candidates(
        4, [SemanticChapter(2, 3, "实现"), SemanticChapter(0, 1, "定义")]
    )
    assert [chapter.title for chapter in result] == ["定义", "实现"]


def test_long_video_is_understood_as_a_whole_before_planning_any_chapters(
    monkeypatch,
):
    topics = ["操作约定", "同一接口的链表示例", "删除节点", "结尾限制：需要更新前驱"]
    source = [
        TranscriptSegment(
            start_seconds=index * 60,
            end_seconds=(index + 1) * 60,
            text="展开解释。" * 300 + topic,
        )
        for index, topic in enumerate(topics)
    ]
    monkeypatch.setattr(chapters, "CHAPTER_WINDOW_MAX_CHARACTERS", 2_000)
    overview = "先借助链表解释抽象接口，再说明节点删除的操作与限制。"
    planned = [
        {
            "title": "接口约定与实现",
            "content_summary": "通过链表示例解释操作约定和实现的关系。",
            "boundary_reason": "先建立后续操作所需的接口背景。",
        },
        {
            "title": "节点删除及限制",
            "content_summary": "介绍删除节点的操作及前驱更新要求。",
            "boundary_reason": "从接口关系转入具体删除问题。",
        },
    ]
    responses = iter(
        [
            *[
                content_understanding(index, index, topic)
                for index, topic in enumerate(topics)
            ],
            json.dumps(
                {
                    "summary": overview,
                    "progression": [
                        {"start_index": index, "end_index": index, "content": topic}
                        for index, topic in enumerate(topics)
                    ],
                }
            ),
            json.dumps({"structure_summary": overview, "chapters": planned}),
            '{"chapters":[{"start_index":0,"end_index":1},{"start_index":2,"end_index":3}]}',
        ]
    )
    requests = []
    progress = []

    def complete(_model, messages, *_args, **kwargs):
        requests.append(messages[0]["content"])
        return next(responses)

    monkeypatch.setattr(chapters, "complete_text", complete)
    result = chapters.build_global_semantic_chapters(
        source, model=object(), on_progress=progress.append
    )
    assert result == [
        SemanticChapter(0, 1, "接口约定与实现", planned[0]["content_summary"]),
        SemanticChapter(2, 3, "节点删除及限制", planned[1]["content_summary"]),
    ]
    assert len(requests) == 7
    assert all(source[index].text in requests[index] for index in range(4))
    assert all(topic in requests[4] for topic in topics)
    assert overview in requests[5]
    assert all(topic in requests[5] for topic in topics)
    assert all('"chapters"' not in request for request in requests[:5])
    assert "start_index" not in requests[5]
    assert "[0] 0.000-60.000" not in requests[5]
    assert all(chapter["title"] in requests[6] for chapter in planned)
    assert "已确定 2 个章节" in progress[-1]


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
        [{"start_index": 0, "end_index": 0}],
        [{"start_index": 1, "end_index": 1}],
        [
            {"start_index": 0, "end_index": 1},
            {"start_index": 1, "end_index": 1},
        ],
        [{"start_index": 0, "end_index": 2}],
        [{"start_index": 0.5, "end_index": 1}],
        [{"start_index": True, "end_index": 1}],
    ],
)
def test_invalid_model_boundaries_fail_instead_of_becoming_local_chapters(
    prediction, monkeypatch
):
    outline = {
        **INTERFACE_OUTLINE,
        "chapters": INTERFACE_OUTLINE["chapters"] * max(len(prediction), 1),
    }
    responses = iter(
        [
            content_understanding(0, 1, "全文介绍接口与实现的关系。"),
            json.dumps(outline),
            *[json.dumps({"chapters": prediction})]
            * chapters.CHAPTER_VALIDATION_ATTEMPTS,
        ]
    )
    monkeypatch.setattr(
        chapters,
        "complete_text",
        lambda *_args, **_kwargs: next(responses),
    )
    with pytest.raises(LlmCompletionError):
        chapters.build_global_semantic_chapters(transcript().segments, model=object())


def test_visual_observations_keep_timestamps_and_do_not_replace_speech(monkeypatch):
    requests = []
    responses = iter(
        [
            content_understanding(0, 1, "全文介绍接口与实现的关系。"),
            json.dumps(INTERFACE_OUTLINE),
            json.dumps(INTERFACE_BOUNDARIES),
        ]
    )

    def complete(_model, messages, *_args, **_kwargs):
        requests.append(messages[0]["content"])
        return next(responses)

    monkeypatch.setattr(chapters, "complete_text", complete)
    chapters.build_global_semantic_chapters(
        transcript().segments,
        model=object(),
        visual_evidence=[
            chapters.ChapterVisualEvidence(15, "画面标题：链表"),
            chapters.ChapterVisualEvidence(100, "其它时间的画面"),
        ],
    )
    assert len(requests) == 3
    for request in (requests[0], requests[2]):
        assert "15.000 秒：画面标题：链表" in request
        assert transcript().segments[-1].text in request
        assert "其它时间的画面" not in request


def test_boundary_alignment_cannot_split_the_chapters_decided_from_full_content(
    monkeypatch,
):
    responses = iter(
        [
            content_understanding(0, 1, "通过链表说明接口与实现的关系。"),
            json.dumps(INTERFACE_OUTLINE),
            *[
                '{"chapters":[{"start_index":0,"end_index":0},{"start_index":1,"end_index":1}]}'
            ]
            * chapters.CHAPTER_VALIDATION_ATTEMPTS,
        ]
    )
    monkeypatch.setattr(
        chapters, "complete_text", lambda *_args, **_kwargs: next(responses)
    )
    with pytest.raises(LlmCompletionError, match="定位阶段改变了全文目录"):
        chapters.build_global_semantic_chapters(transcript().segments, model=object())


@pytest.mark.parametrize("field", ["title", "content_summary", "boundary_reason"])
def test_chapter_outline_requires_a_topic_scope_and_reason(monkeypatch, field):
    outline = {
        **INTERFACE_OUTLINE,
        "chapters": [{**INTERFACE_OUTLINE["chapters"][0], field: " "}],
    }
    responses = iter(
        [
            content_understanding(0, 1, "通过链表说明接口与实现的关系。"),
            *[json.dumps(outline)] * chapters.CHAPTER_VALIDATION_ATTEMPTS,
        ]
    )
    monkeypatch.setattr(
        chapters, "complete_text", lambda *_args, **_kwargs: next(responses)
    )
    with pytest.raises(LlmCompletionError, match="全文目录格式无效"):
        chapters.build_global_semantic_chapters(transcript().segments, model=object())


@pytest.mark.parametrize(
    "understanding",
    [
        {"summary": "缺少内容脉络"},
        {"summary": " ", "progression": []},
        {
            "summary": "漏掉结尾",
            "progression": [{"start_index": 0, "end_index": 0, "content": "只读开头"}],
        },
        {
            "summary": "使用无效索引",
            "progression": [{"start_index": True, "end_index": 1, "content": "内容"}],
        },
    ],
)
def test_incomplete_understanding_stops_before_chapter_planning(
    monkeypatch, understanding
):
    requests = []

    def complete(_model, messages, *_args, **_kwargs):
        requests.append(messages)
        return json.dumps(understanding)

    monkeypatch.setattr(chapters, "complete_text", complete)
    with pytest.raises(LlmCompletionError):
        chapters.build_global_semantic_chapters(transcript().segments, model=object())
    assert len(requests) == chapters.CHAPTER_VALIDATION_ATTEMPTS


def test_unbounded_content_compression_fails_without_looping(monkeypatch):
    monkeypatch.setattr(chapters, "CHAPTER_WINDOW_MAX_CHARACTERS", 200)
    source = [
        TranscriptSegment(start_seconds=index, end_seconds=index + 1, text="原文" * 60)
        for index in range(2)
    ]
    responses = iter(
        [
            content_understanding(index, index, "冗长的重复解释" * 30)
            for index in range(2)
        ]
    )
    monkeypatch.setattr(
        chapters, "complete_text", lambda *_args, **_kwargs: next(responses)
    )
    with pytest.raises(LlmCompletionError, match="压缩未收敛"):
        chapters.build_global_semantic_chapters(source, model=object())


def test_invalid_content_ranges_are_corrected_against_the_original_text(monkeypatch):
    responses = iter(
        [
            content_understanding(0, 2, "第一次错误地引用了不存在的原文索引。"),
            content_understanding(0, 1, "通过链表说明接口与实现的关系。"),
            json.dumps(INTERFACE_OUTLINE),
            json.dumps(INTERFACE_BOUNDARIES),
        ]
    )
    requests = []

    def complete(_model, messages, *_args, **_kwargs):
        requests.append([dict(message) for message in messages])
        return next(responses)

    monkeypatch.setattr(chapters, "complete_text", complete)
    result = chapters.build_global_semantic_chapters(
        transcript().segments, model=object()
    )

    assert len(requests) == 4
    assert requests[1][0] == requests[0][0]
    assert transcript().segments[-1].text in requests[1][0]["content"]
    assert "允许范围为 0-1" in requests[1][-1]["content"]
    assert "通过链表说明接口与实现的关系。" in requests[2][0]["content"]
    assert "不存在的原文索引" not in requests[2][0]["content"]
    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [(0, 1)]


def test_multilevel_understanding_preserves_both_ends_and_source_ranges(monkeypatch):
    monkeypatch.setattr(chapters, "CHAPTER_WINDOW_MAX_CHARACTERS", 600)
    source = [
        TranscriptSegment(
            start_seconds=index, end_seconds=index + 1, text=f"原文{index}。" * 130
        )
        for index in range(8)
    ]
    ranges = []

    def understand(_model, evidence):
        start = evidence[0].start_index
        end = evidence[-1].end_index
        ranges.append((start, end))
        contents = [
            f"保留索引{index}的内容和上下文关系" for index in range(start, end + 1)
        ]
        return chapters.VideoUnderstanding.model_validate_json(
            content_understanding(start, end, "；".join(contents))
        )

    requests = []
    responses = iter(
        [
            json.dumps(INTERFACE_OUTLINE),
            '{"chapters":[{"start_index":0,"end_index":7}]}',
        ]
    )

    def plan(_model, messages, *_args, **_kwargs):
        requests.append(messages[0]["content"])
        return next(responses)

    monkeypatch.setattr(chapters, "_understand_content", understand)
    monkeypatch.setattr(chapters, "complete_text", plan)
    result = chapters.build_global_semantic_chapters(source, model=object())

    assert ranges[:8] == [(index, index) for index in range(8)]
    assert len(ranges) > len(source) + 1
    assert any(0 < end - start < len(source) - 1 for start, end in ranges)
    assert ranges[-1] == (0, 7)
    assert len(requests) == 2
    assert all(f"保留索引{index}的内容" in requests[0] for index in range(8))
    assert [(chapter.start_index, chapter.end_index) for chapter in result] == [(0, 7)]


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
            SemanticChapter(0, 0, "抽象接口", "定义接口的操作约定。"),
            SemanticChapter(1, 1, "链表实现", "使用链表解释接口的实现方式。"),
        ],
    )
    summarized = []

    def summarize(_model, title, text, _ocr, _visual, content_summary):
        summarized.append((title, text, content_summary))
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
    assert summarized[1][2] == "使用链表解释接口的实现方式。"


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
    chapter_scope = "从模型视角说明数据结构的抽象含义。"
    result = chapters.summarize_chapter(
        object(), "抽象视图", source, None, None, chapter_scope
    )
    assert result == "数学逻辑模型就是抽象视图。"
    assert source in requests[1][0]["content"]
    assert all(chapter_scope in request[0]["content"] for request in requests)
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
