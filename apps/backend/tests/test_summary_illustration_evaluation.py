from openvideo.summary_illustration_evaluation import (
    EvaluatedIllustration,
    ExpectedVisualWindow,
    IllustrationEvaluationCase,
    evaluate_illustrations,
)


def test_evaluation_measures_relevance_coverage_duplicates_and_bad_insertions():
    metrics = evaluate_illustrations(
        [
            IllustrationEvaluationCase(
                case_id="games-tutorial",
                expected_windows=[
                    ExpectedVisualWindow(
                        label="打开材质面板",
                        start_seconds=10,
                        end_seconds=20,
                    ),
                    ExpectedVisualWindow(
                        label="完成节点连接",
                        start_seconds=40,
                        end_seconds=50,
                    ),
                ],
                illustrations=[
                    EvaluatedIllustration(
                        selected_time=15,
                        inserted=True,
                        confidence="high",
                        clarity_score=0.9,
                        source_excerpt="打开材质面板",
                        latency_ms=1_000,
                        estimated_vision_cost=0.01,
                    ),
                    EvaluatedIllustration(
                        selected_time=15.5,
                        inserted=True,
                        confidence="high",
                        clarity_score=0.7,
                        source_excerpt="打开材质面板",
                        latency_ms=2_000,
                        estimated_vision_cost=0.01,
                    ),
                    EvaluatedIllustration(
                        selected_time=80,
                        inserted=True,
                        confidence="medium",
                        clarity_score=0.2,
                        latency_ms=3_000,
                        estimated_vision_cost=0.01,
                    ),
                ],
            )
        ]
    )

    assert metrics.case_count == 1
    assert metrics.inserted_count == 3
    assert metrics.relevance == 2 / 3
    assert metrics.clarity == 0.6
    assert metrics.coverage == 0.5
    assert metrics.duplicate_rate == 1 / 3
    assert metrics.bad_insertion_rate == 1 / 3
    assert metrics.average_latency_ms == 2_000
    assert metrics.estimated_vision_cost == 0.03


def test_evaluation_handles_a_valid_zero_image_decision():
    metrics = evaluate_illustrations(
        [
            IllustrationEvaluationCase(
                case_id="text-only",
                illustrations=[EvaluatedIllustration(inserted=False)],
            )
        ]
    )

    assert metrics.inserted_count == 0
    assert metrics.relevance == 0
    assert metrics.bad_insertion_rate == 0
