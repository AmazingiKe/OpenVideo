import json

import pytest

from openvideo.core.analysis import select_timeline_moments
from openvideo.core.event_analysis_models import (
    EventAnalysisJob,
    MarkerEventAnalysisTarget,
)
from openvideo.core.media_models import MediaMarker
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.event_analysis_manager import _event_analysis_messages
from openvideo.tools.analysis_pipeline import _marker_influence_prompt


@pytest.mark.parametrize(
    ("content", "importance", "annotation", "weight"),
    [
        (" 推导过程 ", 0, {"content": "推导过程"}, 0),
        ("", 4, {"importance": 4}, 0.8),
        ("推导过程", 4, {"content": "推导过程", "importance": 4}, 0.8),
        (" \n ", 0, {"importance": 1}, 0.2),
    ],
)
def test_annotation_rules_reach_agent_analysis_and_event_context(
    content, importance, annotation, weight
):
    marker = MediaMarker(
        marker_id="marker-01890f4c7a2b7cc298c4dc0c0c07398f",
        asset_id="01890f4c-7a2b-7cc2-98c4-dc0c0c07398f",
        start_seconds=10,
        end_seconds=11,
        content=content,
        importance=importance,
    )
    assert marker.context_payload() == {
        "marker_id": marker.marker_id,
        "asset_id": marker.asset_id,
        "start_seconds": 10,
        "end_seconds": 11,
        **annotation,
    }
    assert marker.importance == importance
    transcript = Transcript(
        asset_id=marker.asset_id,
        segments=[TranscriptSegment(start_seconds=10, end_seconds=11, text="视频证据")],
    )
    moment = select_timeline_moments(transcript, [marker], 20)[0]
    assert moment.marker_weight == pytest.approx(weight)
    assert len(moment.marker_influences) == 1
    prompt = _marker_influence_prompt(moment.marker_influences[0])
    if marker.content:
        assert marker.content in prompt
        assert "用户注释" in prompt
    if "importance" in annotation:
        assert f"重要程度 {annotation['importance']}/5" in prompt
    else:
        assert "重要程度" not in prompt

    target = MarkerEventAnalysisTarget(**marker.model_dump(exclude={"asset_id"}))
    job = EventAnalysisJob(
        job_id="event-analysis-job-01890f4c7a2b7cc298c4dc0c0c07398f",
        asset_id=marker.asset_id,
        targets=[target],
        preset_id="course_notes",
        preset_version=1,
        depth="balanced",
        ai_model_id="model-01890f4c7a2b7cc298c4dc0c0c07398f",
    )
    messages = _event_analysis_messages(job, target, transcript.segments, [])
    assert json.loads(messages[1]["content"])["target"] == {
        "source": "marker",
        "marker_id": marker.marker_id,
        "start_seconds": 10,
        "end_seconds": 11,
        **annotation,
    }
