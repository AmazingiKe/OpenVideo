from collections.abc import Callable
import asyncio

from fastapi import FastAPI, Header, HTTPException, Query, Request, status
from fastapi.responses import StreamingResponse

from openvideo.agent_registry import (
    AgentConflictError,
    AgentNotFoundError,
    AgentServiceError,
)
from openvideo.agent_service import AgentService
from openvideo.core.agent_runtime_models import (
    AgentArtifact,
    AgentDefinitionAvailability,
    AgentRun,
    AgentRunCreate,
    AgentSession,
    AgentSessionCreate,
    AgentSessionState,
    TERMINAL_AGENT_RUN_STAGES,
)
from openvideo.ui.event_stream import sse_event

AGENT_EVENT_MIN_POLL_SECONDS = 0.1
AGENT_EVENT_MAX_POLL_SECONDS = 0.5
AGENT_EVENT_KEEPALIVE_SECONDS = 15


def register_agent_routes(
    app: FastAPI,
    agent_service: Callable[[], AgentService],
) -> None:
    @app.get(
        "/api/agent-definitions",
        response_model=list[AgentDefinitionAvailability],
    )
    def list_agent_definitions() -> list[AgentDefinitionAvailability]:
        return agent_service().definitions()

    @app.get("/api/agent-sessions", response_model=list[AgentSession])
    def list_agent_sessions(
        agent_id: str | None = None,
        asset_id: str | None = None,
    ) -> list[AgentSession]:
        try:
            return agent_service().sessions(agent_id=agent_id, asset_id=asset_id)
        except AgentServiceError as error:
            raise agent_http_error(error) from error

    @app.post(
        "/api/agent-sessions",
        response_model=AgentSession,
        status_code=status.HTTP_201_CREATED,
    )
    def create_agent_session(request: AgentSessionCreate) -> AgentSession:
        try:
            return agent_service().create_session(request)
        except AgentServiceError as error:
            raise agent_http_error(error) from error

    @app.get("/api/agent-sessions/{session_id}", response_model=AgentSessionState)
    def get_agent_session(session_id: str) -> AgentSessionState:
        try:
            return agent_service().session_state(session_id)
        except AgentServiceError as error:
            raise agent_http_error(error) from error

    @app.post(
        "/api/agent-sessions/{session_id}/runs",
        response_model=AgentRun,
        status_code=status.HTTP_202_ACCEPTED,
    )
    async def create_agent_run(session_id: str, request: AgentRunCreate) -> AgentRun:
        try:
            return await agent_service().create_run(session_id, request)
        except AgentServiceError as error:
            raise agent_http_error(error) from error

    @app.get("/api/agent-runs/{run_id}", response_model=AgentRun)
    def get_agent_run(run_id: str) -> AgentRun:
        try:
            return agent_service().run(run_id)
        except AgentServiceError as error:
            raise agent_http_error(error) from error

    @app.get("/api/agent-runs/{run_id}/events")
    async def agent_run_events(
        run_id: str,
        request: Request,
        after_sequence: int = Query(default=0, ge=0),
        last_event_id: str | None = Header(default=None, alias="Last-Event-ID"),
    ) -> StreamingResponse:
        try:
            agent_service().run(run_id)
        except AgentServiceError as error:
            raise agent_http_error(error) from error
        if last_event_id:
            try:
                after_sequence = max(after_sequence, int(last_event_id))
            except ValueError:
                raise HTTPException(
                    status_code=422, detail="Last-Event-ID 必须是事件序号"
                )

        async def stream_events():
            sequence = after_sequence
            idle_seconds = 0.0
            poll_seconds = AGENT_EVENT_MIN_POLL_SECONDS
            while not await request.is_disconnected():
                events = agent_service().run_events(run_id, sequence)
                for event in events:
                    sequence = event.sequence
                    yield sse_event(
                        event.event_type.value,
                        {
                            "event_id": event.event_id,
                            "sequence": event.sequence,
                            **event.payload,
                        },
                        str(event.sequence),
                    )
                run_state = agent_service().run(run_id)
                if run_state.stage in TERMINAL_AGENT_RUN_STAGES and not events:
                    break
                if not events:
                    idle_seconds += poll_seconds
                    if idle_seconds >= AGENT_EVENT_KEEPALIVE_SECONDS:
                        yield ": keep-alive\n\n"
                        idle_seconds = 0.0
                else:
                    idle_seconds = 0.0
                    poll_seconds = AGENT_EVENT_MIN_POLL_SECONDS
                await asyncio.sleep(poll_seconds)
                if not events:
                    poll_seconds = min(
                        AGENT_EVENT_MAX_POLL_SECONDS,
                        poll_seconds * 2,
                    )

        return StreamingResponse(
            stream_events(),
            media_type="text/event-stream",
            headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
        )

    @app.post("/api/agent-runs/{run_id}/cancel", response_model=AgentRun)
    async def cancel_agent_run(run_id: str) -> AgentRun:
        try:
            return await agent_service().cancel(run_id)
        except AgentServiceError as error:
            raise agent_http_error(error) from error

    @app.post(
        "/api/agent-artifacts/{artifact_id}/approve",
        response_model=AgentArtifact,
    )
    def approve_agent_artifact(artifact_id: str) -> AgentArtifact:
        try:
            return agent_service().approve(artifact_id)
        except AgentServiceError as error:
            raise agent_http_error(error) from error

    @app.post(
        "/api/agent-artifacts/{artifact_id}/reject",
        response_model=AgentArtifact,
    )
    def reject_agent_artifact(artifact_id: str) -> AgentArtifact:
        try:
            return agent_service().reject(artifact_id)
        except AgentServiceError as error:
            raise agent_http_error(error) from error


def agent_http_error(error: AgentServiceError) -> HTTPException:
    status_code = status.HTTP_422_UNPROCESSABLE_CONTENT
    if isinstance(error, AgentNotFoundError):
        status_code = status.HTTP_404_NOT_FOUND
    elif isinstance(error, AgentConflictError):
        status_code = status.HTTP_409_CONFLICT
    return HTTPException(
        status_code=status_code,
        detail={"code": error.code, "message": str(error)},
    )
