"""标记 Agent 的会话与批量建议契约。"""

from datetime import UTC, datetime
from enum import StrEnum

from pydantic import BaseModel, Field

from openvideo.core.agent_runtime_models import AgentEvent, AgentSession
from openvideo.core.media_models import MediaMarker


class MarkerRetrievalMode(StrEnum):
    TRANSCRIPT = "transcript"
    AUTO = "auto"
    VISION = "vision"


class MarkerProposalOperation(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    MERGE = "merge"


class MarkerProposalStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    REJECTED = "rejected"
    STALE = "stale"


class MarkerProposalChange(BaseModel):
    operation: MarkerProposalOperation
    before: list[MediaMarker] = Field(default_factory=list)
    after: MediaMarker | None = None
    reason: str = Field(min_length=1, max_length=2_000)
    evidence: list[str] = Field(default_factory=list, max_length=20)


class MarkerProposal(BaseModel):
    proposal_id: str
    session_id: str
    asset_id: str
    changes: list[MarkerProposalChange] = Field(min_length=1, max_length=100)
    status: MarkerProposalStatus = MarkerProposalStatus.PENDING
    created_at: datetime = Field(default_factory=lambda: datetime.now(UTC))


class MarkerAgentSession(BaseModel):
    session: AgentSession
    asset_id: str


class MarkerAgentSessionState(MarkerAgentSession):
    events: list[AgentEvent] = Field(default_factory=list)
    proposals: list[MarkerProposal] = Field(default_factory=list)


class MarkerAgentMessageRequest(BaseModel):
    content: str = Field(min_length=1, max_length=20_000)
    ai_model_id: str
    retrieval_mode: MarkerRetrievalMode = MarkerRetrievalMode.AUTO
