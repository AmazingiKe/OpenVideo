"""用固定困难查询复查召回与排序，只使用临时资料库和已经安装的本地模型。"""

from __future__ import annotations

import argparse
from functools import lru_cache
import json
import math
from pathlib import Path
from tempfile import TemporaryDirectory
from time import perf_counter

from openvideo.agent_retrieval_models import (
    EMBEDDING_MODEL,
    RERANKER_MODEL,
    NeuralRetrievalModels,
    _installed_manifest_matches,
)
from openvideo.core.library import MediaLibrary
from openvideo.core.media_models import (
    MediaAsset,
    MediaAssetStatus,
    MediaSegment,
    SourcePlatform,
)
from openvideo.core.identifiers import uuid7
from openvideo.core.model_download_models import MODEL_MANIFEST_FILE_NAME
from openvideo.core.transcription_models import Transcript, TranscriptSegment


DEFAULT_CASES = Path(__file__).parent / "fixtures" / "text_retrieval_cases.json"
EVALUATION_CUTOFF = 3


def evaluate(cases_path: Path, *, neural: bool) -> dict[str, object]:
    cases = json.loads(cases_path.read_text(encoding="utf-8"))
    models = NeuralRetrievalModels() if neural else None
    if models is not None:
        for spec in (EMBEDDING_MODEL, RERANKER_MODEL):
            directory = models._model_directory(spec)
            if not _installed_manifest_matches(
                directory / MODEL_MANIFEST_FILE_NAME, spec
            ):
                raise RuntimeError("评测只使用已安装并校验过的检索模型，不会下载模型")

    @lru_cache(maxsize=256)
    def encode_query(query, model_name, model_version, dimensions):
        assert models is not None
        return models.encode_query(query, model_name, model_version, dimensions)

    @lru_cache(maxsize=256)
    def cached_rerank(query: str, documents: tuple[str, ...]):
        assert models is not None
        return models.rerank(query, documents)

    def rerank(query, documents):
        return cached_rerank(query, tuple(documents))

    with TemporaryDirectory(prefix="openvideo-text-retrieval-") as temporary:
        library = MediaLibrary.initialize_directory(Path(temporary))
        try:
            asset_ids = {asset["key"]: str(uuid7()) for asset in cases["assets"]}
            document_keys = {}
            for asset in cases["assets"]:
                asset_id = asset_ids[asset["key"]]
                library.save(
                    MediaAsset(
                        asset_id=asset_id,
                        source_url=f"https://example.com/{asset['key']}",
                        source_platform=SourcePlatform.YOUTUBE,
                        title=asset["title"],
                        duration_seconds=2_000,
                        status=MediaAssetStatus.READY,
                    )
                )
                transcripts = []
                segments = []
                for position, document in enumerate(cases["documents"]):
                    if document["asset"] != asset["key"]:
                        continue
                    start = position * 25
                    end = start + 20
                    document_keys[(asset_id, start, document["text"])] = document["key"]
                    if document.get("source", "transcript") == "transcript":
                        transcripts.append(
                            TranscriptSegment(
                                start_seconds=start,
                                end_seconds=end,
                                text=document["text"],
                            )
                        )
                    else:
                        field = {
                            "analysis": "detailed_summary",
                            "ocr": "ocr_text",
                            "visual": "visual_description",
                        }[document["source"]]
                        segments.append(
                            MediaSegment(
                                segment_id=f"segment-{uuid7().hex}",
                                asset_id=asset_id,
                                start_seconds=start,
                                end_seconds=end,
                                **{field: document["text"]},
                            )
                        )
                library.save_transcript(
                    Transcript(asset_id=asset_id, segments=transcripts)
                )
                if segments:
                    library.save_segments(asset_id, segments)
            started = perf_counter()
            if models is not None:
                library.rebuild_agent_semantic_index(
                    model_name=models.model_name,
                    model_version=models.model_version,
                    dimensions=models.dimensions,
                    encode_documents=models.encode_documents,
                )
            results = []
            for case in cases["queries"]:
                search_arguments = {
                    "asset_ids": [
                        asset_ids[key] for key in case.get("scope", asset_ids)
                    ],
                    "query": case["query"],
                    "start_seconds": None,
                    "end_seconds": None,
                    "limit": EVALUATION_CUTOFF,
                    "query_encoder": encode_query if models is not None else None,
                    "reranker": rerank if models is not None else None,
                }
                evidence = library.search_agent_evidence(**search_arguments)
                repeated = library.search_agent_evidence(**search_arguments)
                ranked_keys = [
                    document_keys[(item.asset_id, item.start_seconds, item.text)]
                    for item in evidence
                ]
                repeated_keys = [
                    document_keys[(item.asset_id, item.start_seconds, item.text)]
                    for item in repeated
                ]
                relevant = set(case["relevant"])
                gains = [int(key in relevant) for key in ranked_keys]
                reciprocal_rank = next(
                    (1 / rank for rank, gain in enumerate(gains, start=1) if gain), 0
                )
                dcg = sum(
                    gain / math.log2(rank + 1)
                    for rank, gain in enumerate(gains, start=1)
                )
                ideal_dcg = sum(
                    1 / math.log2(rank + 1)
                    for rank in range(1, min(len(relevant), EVALUATION_CUTOFF) + 1)
                )
                results.append(
                    {
                        "key": case["key"],
                        "query": case["query"],
                        "ranked": ranked_keys,
                        "relevant": case["relevant"],
                        "recall_at_3": sum(gains) / len(relevant),
                        "reciprocal_rank": reciprocal_rank,
                        "ndcg_at_3": dcg / ideal_dcg,
                        "deterministic": ranked_keys == repeated_keys,
                    }
                )
            return {
                "mode": "neural_reranker" if neural else "lexical",
                "query_count": len(results),
                "metrics": {
                    key: sum(result[key] for result in results) / len(results)
                    for key in ("recall_at_3", "reciprocal_rank", "ndcg_at_3")
                },
                "deterministic": all(result["deterministic"] for result in results),
                "elapsed_seconds": round(perf_counter() - started, 3),
                "queries": results,
            }
        finally:
            library.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--neural", action="store_true")
    parser.add_argument("--output", type=Path, required=True)
    arguments = parser.parse_args()
    report = evaluate(arguments.cases, neural=arguments.neural)
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_text(
        json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    print(
        json.dumps(
            {key: value for key, value in report.items() if key != "queries"},
            ensure_ascii=False,
        )
    )
