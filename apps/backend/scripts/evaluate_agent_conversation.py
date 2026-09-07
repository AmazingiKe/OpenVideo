"""在隔离资料库中实测真实模型对话，记录耗时、历史、审批和失败恢复。"""

from __future__ import annotations

import argparse
from collections import Counter
import csv
import json
from pathlib import Path
from statistics import median, quantiles
from tempfile import TemporaryDirectory
from time import monotonic, sleep

from fastapi.testclient import TestClient

from openvideo.agent_retrieval_models import (
    EMBEDDING_MODEL,
    RERANKER_MODEL,
    NeuralRetrievalModels,
    _installed_manifest_matches,
)
from openvideo.configuration import OPENVIDEO_CONFIG_DIRECTORY
from openvideo.core.agent_runtime_models import TERMINAL_AGENT_RUN_STAGES
from openvideo.core.identifiers import uuid7
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import MediaAsset, MediaAssetStatus, SourcePlatform
from openvideo.core.model_download_models import MODEL_MANIFEST_FILE_NAME
from openvideo.core.transcription_models import Transcript, TranscriptSegment
from openvideo.preferences import PreferenceStore
from openvideo.settings import load_settings
from openvideo.ui.api import create_app

CASES_PATH = Path(__file__).parent / "fixtures" / "text_retrieval_cases.json"
RUN_TIMEOUT_SECONDS = 180
POLL_SECONDS = 0.2
TERMINAL_OBSERVATION_SECONDS = 1
MEMORY_VALUE = "蓝鲸四十二"
EVIDENCE_SPACING_SECONDS = 25
EVIDENCE_DURATION_SECONDS = 20
ASSET_DURATION_SECONDS = 2000
VIDEO_QUESTION_ROUNDS = frozenset({2, 3, 4, 5, 6, 8, 10})
CONVERSATION_ONLY_ROUNDS = frozenset({1, 7, 12})
CONVERSATION = (
    (f"记住本次测试口令是{MEMORY_VALUE}，回复记住了即可。", "current_asset", None),
    (
        "检索当前视频，透视投影和正交投影有什么不同？简短回答并引用时间。",
        "current_asset",
        None,
    ),
    ("刚才第二种投影适合什么场景？", "current_asset", None),
    ("检索说明焦距变长如何影响视场角。", "current_asset", None),
    ("为什么法线贴图要禁用sRGB？", "current_asset", None),
    ("Panner怎样让贴图停止移动？给出时间。", "current_asset", None),
    ("本次对话最初让我记住的测试口令是什么？只回答口令。", "current_asset", "memory"),
    ("资料库中有量子纠缠实验成功率的证据吗？没有就说明。", "library", None),
    (
        "仅根据字幕生成两个关于投影区别的标记提案，等待我审批，不需要看画面。",
        "current_asset",
        "approve_undo",
    ),
    ("检索整个资料库，梯度裁剪与zero_grad的区别是什么？", "library", None),
    (
        "仅根据字幕生成一个关于法线贴图的标记提案，等待我审批，不需要看画面。",
        "current_asset",
        "reject",
    ),
    ("本次对话最初让我记住的测试口令是什么？只回答口令。", "current_asset", "memory"),
)


def wait_run(client: TestClient, run: dict) -> dict:
    """给评测设置墙钟边界，超时保存取消状态而不是永久等待。"""
    deadline = monotonic() + RUN_TIMEOUT_SECONDS
    while run["stage"] not in TERMINAL_AGENT_RUN_STAGES:
        if monotonic() >= deadline:
            client.post(f"/api/agent-runs/{run['run_id']}/cancel").raise_for_status()
            return client.get(f"/api/agent-runs/{run['run_id']}").json()
        sleep(POLL_SECONDS)
        response = client.get(f"/api/agent-runs/{run['run_id']}")
        response.raise_for_status()
        run = response.json()
    return run


def evaluate(output: Path, rounds: int, neural: bool) -> dict:
    output.mkdir(parents=True, exist_ok=False)
    settings = load_settings()
    if not settings.online_ai_models:
        raise ValueError("请先配置可用的在线模型")
    model = settings.online_ai_models[0]
    settings.agent.permission_mode = "request_approval"
    settings.agent.always_allowed_grants = []
    models = NeuralRetrievalModels() if neural else None
    if models is not None:
        for spec in (EMBEDDING_MODEL, RERANKER_MODEL):
            if not _installed_manifest_matches(
                models._model_directory(spec) / MODEL_MANIFEST_FILE_NAME, spec
            ):
                raise ValueError("神经检索评测只使用已经安装的模型")
    cases = json.loads(CASES_PATH.read_text(encoding="utf-8"))
    results = []
    with TemporaryDirectory(prefix="openvideo-agent-evaluation-") as temporary:
        settings.library_path = Path(temporary)
        library = MediaLibrary.initialize_directory(settings.library_path)
        assets = {}
        try:
            for asset in cases["assets"]:
                asset_id = str(uuid7())
                assets[asset["key"]] = asset_id
                library.save(
                    MediaAsset(
                        asset_id=asset_id,
                        source_url="https://example.com/evaluation",
                        source_platform=SourcePlatform.YOUTUBE,
                        title=asset["title"],
                        duration_seconds=ASSET_DURATION_SECONDS,
                        status=MediaAssetStatus.READY,
                    )
                )
                library.save_transcript(
                    Transcript(
                        asset_id=asset_id,
                        segments=[
                            TranscriptSegment(
                                start_seconds=index * EVIDENCE_SPACING_SECONDS,
                                end_seconds=index * EVIDENCE_SPACING_SECONDS
                                + EVIDENCE_DURATION_SECONDS,
                                text=document["text"],
                            )
                            for index, document in enumerate(cases["documents"])
                            if document["asset"] == asset["key"]
                        ],
                    )
                )
        finally:
            library.close()
        config_directory = OPENVIDEO_CONFIG_DIRECTORY / "agent-evaluation" / uuid7().hex
        app = create_app(
            settings=settings,
            preference_store=PreferenceStore(config_directory / "preferences.json"),
            retrieval_models=models,
        )
        with (
            TestClient(app) as client,
            (output / "conversation.jsonl").open("w", encoding="utf-8") as log,
        ):
            response = client.post(
                "/api/agent-sessions",
                json={
                    "agent_id": "marker",
                    "asset_id": assets["graphics"],
                    "title": "连续对话实测",
                },
            )
            response.raise_for_status()
            session_id = response.json()["session_id"]
            for index in range(rounds):
                prompt, scope, action = CONVERSATION[index % len(CONVERSATION)]
                if index and index % len(CONVERSATION) == 0:
                    prompt = "继续之前的对话，简短确认即可。"
                started = monotonic()
                request = {
                    "request_key": f"request-{uuid7().hex}",
                    "ai_model_id": model.model_id,
                    "content": prompt,
                    "retrieval_scope": scope,
                }
                response = client.post(
                    f"/api/agent-sessions/{session_id}/runs", json=request
                )
                record = {
                    "round": index + 1,
                    "prompt": prompt,
                    "http_status": response.status_code,
                }
                if response.status_code != 202:
                    record["error"] = response.json()
                else:
                    run = wait_run(client, response.json())
                    record["run"] = run
                    record["wall_ms"] = round((monotonic() - started) * 1000)
                    state = client.get(f"/api/agent-sessions/{session_id}").json()
                    events = [
                        event
                        for event in state["events"]
                        if event.get("run_id") == run["run_id"]
                        and event["event_type"] != "reasoning.delta"
                    ]
                    record["events"] = events
                    record["answer"] = "\n".join(
                        event["payload"]["content"]
                        for event in events
                        if event["event_type"] == "message.completed"
                    )
                    if action == "memory":
                        record["memory_correct"] = MEMORY_VALUE in record["answer"]
                    if action in ("approve_undo", "reject"):
                        artifacts = [
                            artifact
                            for artifact in state["artifacts"]
                            if artifact["run_id"] == run["run_id"]
                        ]
                        record["artifact_count"] = len(artifacts)
                        record["actions"] = []
                        before = app.state.library.load_markers(assets["graphics"])
                        for artifact in artifacts:
                            operations = (
                                ("approve", "undo")
                                if action == "approve_undo"
                                else ("reject",)
                            )
                            for operation in operations:
                                result = client.post(
                                    f"/api/agent-artifacts/{artifact['artifact_id']}/{operation}",
                                    json={"grant_scope": "once"}
                                    if operation == "approve"
                                    else None,
                                )
                                record["actions"].append(
                                    {
                                        "operation": operation,
                                        "status": result.status_code,
                                        "result": result.json(),
                                    }
                                )
                                if operation == "approve":
                                    record["markers_applied"] = (
                                        before
                                        != app.state.library.load_markers(
                                            assets["graphics"]
                                        )
                                    )
                        record["markers_restored"] = (
                            before == app.state.library.load_markers(assets["graphics"])
                        )
                    sleep(TERMINAL_OBSERVATION_SECONDS)
                    after = client.get(f"/api/agent-runs/{run['run_id']}").json()
                    record["events_after_terminal"] = (
                        after["latest_event_sequence"] - run["latest_event_sequence"]
                    )
                record.setdefault("wall_ms", round((monotonic() - started) * 1000))
                results.append(record)
                log.write(json.dumps(record, ensure_ascii=False) + "\n")
                log.flush()
            # 主动取消与从头重试也走真实模型和真实 API。
            request = {
                "request_key": f"request-{uuid7().hex}",
                "ai_model_id": model.model_id,
                "content": "检索说明透视投影的特点。",
            }
            response = client.post(
                f"/api/agent-sessions/{session_id}/runs", json=request
            )
            lifecycle = {"creation_status": response.status_code}
            if response.status_code == 202:
                run_id = response.json()["run_id"]
                duplicate = client.post(
                    f"/api/agent-sessions/{session_id}/runs", json=request
                )
                lifecycle["idempotent"] = duplicate.json().get("run_id") == run_id
                lifecycle["cancelled"] = client.post(
                    f"/api/agent-runs/{run_id}/cancel"
                ).json()
                retried = client.post(f"/api/agent-runs/{run_id}/retry")
                lifecycle["retry_http_status"] = retried.status_code
                if retried.status_code == 200:
                    lifecycle["retry"] = wait_run(client, retried.json())
            context = client.portal.call(
                app.state.agent_service.agno_session_context.database.get_session,
                session_id,
            )
            persisted_user_messages = [
                message.content
                for message in context.get_messages()
                if message.role == "user" and isinstance(message.content, str)
            ]
            missing_history = [
                record["round"]
                for record in results
                if record.get("run", {}).get("stage")
                in ("complete", "waiting_for_approval")
                and not any(
                    record["prompt"] in content for content in persisted_user_messages
                )
            ]
            summary = {
                "model": model.litellm_model,
                "neural": neural,
                "rounds": rounds,
                "outcomes": dict(
                    Counter(
                        record.get("run", {}).get("stage", str(record["http_status"]))
                        for record in results
                    )
                ),
                "memory_probes": [
                    {
                        "round": record["round"],
                        "correct": record.get("memory_correct", False),
                    }
                    for record in results
                    if CONVERSATION[(record["round"] - 1) % len(CONVERSATION)][2]
                    == "memory"
                ],
                "sdk_statuses": dict(Counter(str(run.status) for run in context.runs)),
                "history_messages": len(context.get_messages()),
                "missing_history_rounds": missing_history,
                "lifecycle": lifecycle,
            }
            proposals = [
                record
                for record in results
                if CONVERSATION[(record["round"] - 1) % len(CONVERSATION)][2]
                in ("approve_undo", "reject")
            ]
            summary["checks"] = {
                "video_answers_retrieved": all(
                    any(
                        event["event_type"] == "tool.status"
                        and event["payload"].get("name") == "search_evidence"
                        and event["payload"].get("stage") == "completed"
                        for event in record.get("events", [])
                    )
                    for record in results
                    if (record["round"] - 1) % len(CONVERSATION) + 1
                    in VIDEO_QUESTION_ROUNDS
                ),
                "conversation_without_search": all(
                    not any(
                        event["event_type"] == "tool.status"
                        and event["payload"].get("name")
                        in ("search_evidence", "inspect_frames")
                        for event in record.get("events", [])
                    )
                    for record in results
                    if (record["round"] - 1) % len(CONVERSATION) + 1
                    in CONVERSATION_ONLY_ROUNDS
                ),
                "requests_completed": all(
                    record.get("run", {}).get("stage")
                    in ("complete", "waiting_for_approval")
                    for record in results
                ),
                "expected_workflow": all(
                    record.get("run", {}).get("stage")
                    == (
                        "waiting_for_approval"
                        if CONVERSATION[(record["round"] - 1) % len(CONVERSATION)][2]
                        in ("approve_undo", "reject")
                        else "complete"
                    )
                    for record in results
                ),
                "memory": all(probe["correct"] for probe in summary["memory_probes"]),
                "proposals": all(
                    record.get("artifact_count", 0) > 0
                    and record.get("markers_restored")
                    and record.get("markers_applied", True)
                    and all(
                        action["status"] == 200 for action in record.get("actions", [])
                    )
                    for record in proposals
                ),
                "no_events_after_terminal": all(
                    record.get("events_after_terminal", 0) == 0 for record in results
                ),
                "history_preserved": bool(persisted_user_messages)
                and not missing_history,
                "cancel_and_retry": lifecycle.get("idempotent", False)
                and lifecycle.get("cancelled", {}).get("stage") == "cancelled"
                and lifecycle.get("retry", {}).get("stage") == "complete",
            }
            timings = [
                {
                    "round": record["round"],
                    "wall_ms": record["wall_ms"],
                    "retrieval_ms": record.get("run", {})
                    .get("metrics", {})
                    .get("retrieval_ms"),
                }
                for record in results
            ]
            with (output / "timings.csv").open(
                "w", encoding="utf-8-sig", newline=""
            ) as stream:
                writer = csv.DictWriter(
                    stream, fieldnames=["round", "wall_ms", "retrieval_ms"]
                )
                writer.writeheader()
                writer.writerows(timings)
            for field in ("wall_ms", "retrieval_ms"):
                values = [row[field] for row in timings if row[field] is not None]
                summary[field] = (
                    {
                        "p50": median(values),
                        "p95": quantiles(values, n=100, method="inclusive")[94],
                    }
                    if len(values) > 1
                    else None
                )
            (output / "summary.json").write_text(
                json.dumps(summary, ensure_ascii=False, indent=2), encoding="utf-8"
            )
    return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=24)
    parser.add_argument("--neural", action="store_true")
    arguments = parser.parse_args()
    if arguments.rounds < len(CONVERSATION):
        parser.error(f"至少运行 {len(CONVERSATION)} 轮才能覆盖全部场景")
    result = evaluate(arguments.output, arguments.rounds, arguments.neural)
    if not all(result["checks"].values()):
        raise SystemExit(1)
