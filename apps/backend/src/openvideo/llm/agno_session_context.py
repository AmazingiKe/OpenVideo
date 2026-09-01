"""Agno 会话持久化集中承接模型历史、摘要与工具结果压缩。"""

from __future__ import annotations

import asyncio
from pathlib import Path
from time import time
from typing import Any

from agno.db.sqlite import AsyncSqliteDb
from agno.models.base import Model
from agno.models.message import Message
from agno.run.agent import RunInput, RunOutput
from agno.run.base import RunStatus
from agno.session import AgentSession
from agno.session.summary import SessionSummaryManager

from openvideo.core.identifiers import uuid7


AGNO_CONTEXT_DATABASE_FILE_NAME = "agent-context.sqlite3"
AGNO_CONTEXT_SESSION_TABLE = "openvideo_agent_context"
AGNO_HISTORY_RUN_COUNT = 3
AGNO_HISTORY_TOOL_CALL_LIMIT = 3


class AgnoSessionContext:
    """让 Agno 成为唯一模型上下文来源，同时迁移已有 OpenVideo 对话。"""

    def __init__(self, database_path: Path) -> None:
        self.database = AsyncSqliteDb(
            db_file=str(database_path),
            session_table=AGNO_CONTEXT_SESSION_TABLE,
        )
        self._migration_lock = asyncio.Lock()

    async def ensure_session(
        self,
        session_id: str,
        agent_id: str,
        historical_messages: list[dict[str, Any]],
    ) -> bool:
        if await self.database.get_session(session_id) is not None:
            return False
        async with self._migration_lock:
            if await self.database.get_session(session_id) is not None:
                return False
            created_at = int(time())
            session = AgentSession(
                session_id=session_id,
                agent_id=agent_id,
                runs=self._historical_runs(
                    session_id,
                    agent_id,
                    historical_messages,
                    created_at,
                ),
                created_at=created_at,
                updated_at=created_at,
            )
            await self.database.upsert_session(session)
            return bool(session.runs)

    async def compact_session(self, session_id: str, model: Model) -> bool:
        session = await self.database.get_session(session_id)
        if not isinstance(session, AgentSession) or not session.runs:
            return False
        manager = SessionSummaryManager(model=model)
        summary = await manager.acreate_session_summary(session)
        if summary is None:
            return False
        session.updated_at = int(time())
        await self.database.upsert_session(session)
        return True

    async def close(self) -> None:
        await self.database.close()

    @staticmethod
    def _historical_runs(
        session_id: str,
        agent_id: str,
        historical_messages: list[dict[str, Any]],
        created_at: int,
    ) -> list[RunOutput]:
        runs: list[RunOutput] = []
        user_content: str | None = None
        for historical_message in historical_messages:
            role = historical_message.get("role")
            content = str(historical_message.get("content", "")).strip()
            if role == "user":
                user_content = content or None
                continue
            if role != "assistant" or not content or user_content is None:
                continue
            runs.append(
                RunOutput(
                    run_id=f"agno-import-{uuid7().hex}",
                    agent_id=agent_id,
                    session_id=session_id,
                    input=RunInput(input_content=user_content),
                    content=content,
                    messages=[
                        Message(role="user", content=user_content),
                        Message(role="assistant", content=content),
                    ],
                    status=RunStatus.completed,
                    created_at=created_at,
                )
            )
            user_content = None
        return runs
