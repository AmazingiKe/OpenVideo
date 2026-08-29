"""独立保存可丢弃的 Agent 检查点，避免污染可重建业务投影。"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from openvideo.core.agent_runtime_models import AgentRunCheckpoint


def open_agent_checkpoint_database(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path, check_same_thread=False)
    connection.row_factory = sqlite3.Row
    connection.execute("PRAGMA journal_mode = WAL")
    with connection:
        connection.execute(
            "CREATE TABLE IF NOT EXISTS agent_run_checkpoints ("
            "run_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, "
            "request TEXT NOT NULL, stage TEXT NOT NULL, "
            "completed_steps TEXT NOT NULL, resume_allowed INTEGER NOT NULL, "
            "updated_at TEXT NOT NULL)"
        )
        connection.execute(
            "CREATE INDEX IF NOT EXISTS agent_checkpoint_session_index "
            "ON agent_run_checkpoints(session_id, updated_at DESC)"
        )
    return connection


def save_agent_checkpoint(
    connection: sqlite3.Connection,
    checkpoint: AgentRunCheckpoint,
) -> None:
    values = checkpoint.model_dump(mode="json")
    values["request"] = json.dumps(values["request"], ensure_ascii=False)
    values["completed_steps"] = json.dumps(
        values["completed_steps"],
        ensure_ascii=False,
    )
    columns = tuple(values)
    updates = ", ".join(
        f"{column}=excluded.{column}" for column in columns if column != "run_id"
    )
    with connection:
        connection.execute(
            f"INSERT INTO agent_run_checkpoints ({', '.join(columns)}) "
            f"VALUES ({', '.join('?' for _ in columns)}) "
            f"ON CONFLICT(run_id) DO UPDATE SET {updates}",
            tuple(values[column] for column in columns),
        )


def load_agent_checkpoint(
    connection: sqlite3.Connection,
    run_id: str,
) -> AgentRunCheckpoint | None:
    row = connection.execute(
        "SELECT * FROM agent_run_checkpoints WHERE run_id = ?",
        (run_id,),
    ).fetchone()
    return _checkpoint_from_row(row) if row else None


def load_agent_checkpoints(
    connection: sqlite3.Connection,
) -> list[AgentRunCheckpoint]:
    rows = connection.execute(
        "SELECT * FROM agent_run_checkpoints ORDER BY updated_at DESC"
    ).fetchall()
    return [_checkpoint_from_row(row) for row in rows]


def _checkpoint_from_row(row: sqlite3.Row) -> AgentRunCheckpoint:
    values = dict(row)
    values["request"] = json.loads(values["request"])
    values["completed_steps"] = json.loads(values["completed_steps"])
    values["resume_allowed"] = bool(values["resume_allowed"])
    return AgentRunCheckpoint.model_validate(values)
