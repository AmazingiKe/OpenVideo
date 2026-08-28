"""Agent 权限、模型角色与用户偏好的稳定数据契约。"""

from __future__ import annotations

from enum import StrEnum

from pydantic import BaseModel, Field, field_validator, model_validator

from openvideo.core.identifiers import is_prefixed_uuid7, uuid7


class AgentPermissionMode(StrEnum):
    REQUEST_APPROVAL = "request_approval"
    SMART_APPROVAL = "smart_approval"
    FULL_ACCESS = "full_access"


class AgentThinkingMode(StrEnum):
    AUTO = "auto"
    FAST = "fast"
    COMPLEX = "complex"


class AgentRetrievalScope(StrEnum):
    CURRENT_ASSET = "current_asset"
    LIBRARY = "library"


class AgentModelRole(StrEnum):
    FAST = "fast"
    COMPLEX = "complex"
    VISION = "vision"


class AgentToolEffect(StrEnum):
    READ = "read"
    WRITE = "write"
    DELETE = "delete"
    EXTERNAL = "external"


class AgentResourceScope(StrEnum):
    CURRENT_ITEM = "current_item"
    SELECTION = "selection"
    LIBRARY = "library"
    APPLICATION = "application"
    EXTERNAL = "external"


class AgentPermissionGrantScope(StrEnum):
    ONCE = "once"
    SESSION = "session"
    ALWAYS = "always"


class AgentPermissionOutcome(StrEnum):
    ALLOW = "allow"
    ASK = "ask"
    DENY = "deny"


class AgentPermissionGrant(BaseModel):
    """把一次授权限制在明确能力、资源与生命周期内，避免权限蔓延。"""

    grant_id: str = Field(default_factory=lambda: f"grant-{uuid7().hex}")
    capability: str = Field(pattern=r"^[a-z][a-z0-9_.]{1,99}$")
    resource_scope: AgentResourceScope
    resource_id: str | None = Field(default=None, min_length=1, max_length=200)
    scope: AgentPermissionGrantScope
    request_id: str | None = None
    session_id: str | None = None

    @field_validator("grant_id")
    @classmethod
    def validate_grant_id(cls, value: str) -> str:
        if not is_prefixed_uuid7(value, "grant-"):
            raise ValueError("授权标识必须使用 grant- 前缀和 UUIDv7 十六进制")
        return value

    @field_validator("request_id")
    @classmethod
    def validate_request_id(cls, value: str | None) -> str | None:
        if value is not None and not is_prefixed_uuid7(value, "request-"):
            raise ValueError("请求标识必须使用 request- 前缀和 UUIDv7 十六进制")
        return value

    @field_validator("session_id")
    @classmethod
    def validate_session_id(cls, value: str | None) -> str | None:
        if value is not None and not is_prefixed_uuid7(value, "session-"):
            raise ValueError("会话标识必须使用 session- 前缀和 UUIDv7 十六进制")
        return value

    @model_validator(mode="after")
    def validate_scope_binding(self) -> "AgentPermissionGrant":
        if self.scope == AgentPermissionGrantScope.ONCE:
            if self.request_id is None or self.session_id is not None:
                raise ValueError("单次授权必须且只能绑定请求")
        elif self.scope == AgentPermissionGrantScope.SESSION:
            if self.session_id is None or self.request_id is not None:
                raise ValueError("对话授权必须且只能绑定会话")
        elif self.request_id is not None or self.session_id is not None:
            raise ValueError("始终允许授权不能绑定请求或会话")
        return self


class AgentPreferences(BaseModel):
    """保存整个应用共用的 Agent 倾向，对话可在运行时临时覆盖。"""

    permission_mode: AgentPermissionMode = AgentPermissionMode.SMART_APPROVAL
    fast_model_id: str | None = None
    complex_model_id: str | None = None
    vision_model_id: str | None = None
    default_thinking_mode: AgentThinkingMode = AgentThinkingMode.AUTO
    max_concurrent_runs: int = Field(default=4, ge=1, le=32)
    always_allowed_grants: list[AgentPermissionGrant] = Field(default_factory=list)

    @field_validator("fast_model_id", "complex_model_id", "vision_model_id")
    @classmethod
    def validate_model_id(cls, value: str | None) -> str | None:
        if value is not None and not is_prefixed_uuid7(value, "model-"):
            raise ValueError("Agent 模型角色必须引用 UUIDv7 模型标识")
        return value

    @field_validator("always_allowed_grants")
    @classmethod
    def validate_persisted_grants(
        cls, grants: list[AgentPermissionGrant]
    ) -> list[AgentPermissionGrant]:
        if any(grant.scope != AgentPermissionGrantScope.ALWAYS for grant in grants):
            raise ValueError("用户偏好只能持久化始终允许授权")
        grant_ids = [grant.grant_id for grant in grants]
        if len(grant_ids) != len(set(grant_ids)):
            raise ValueError("Agent 授权标识不能重复")
        return grants


class AgentToolPermissionPolicy(BaseModel):
    """工具风险由程序静态声明，模型生成的参数不能改变这些边界。"""

    capability: str = Field(pattern=r"^[a-z][a-z0-9_.]{1,99}$")
    effect: AgentToolEffect
    resource_scope: AgentResourceScope
    reversible: bool
    bulk: bool = False
    enabled: bool = True


class AgentPermissionContext(BaseModel):
    request_id: str
    session_id: str
    resource_id: str | None = Field(default=None, min_length=1, max_length=200)

    @field_validator("request_id")
    @classmethod
    def validate_request_id(cls, value: str) -> str:
        if not is_prefixed_uuid7(value, "request-"):
            raise ValueError("请求标识必须使用 request- 前缀和 UUIDv7 十六进制")
        return value

    @field_validator("session_id")
    @classmethod
    def validate_session_id(cls, value: str) -> str:
        if not is_prefixed_uuid7(value, "session-"):
            raise ValueError("会话标识必须使用 session- 前缀和 UUIDv7 十六进制")
        return value


class AgentPermissionDecision(BaseModel):
    outcome: AgentPermissionOutcome
    reason: str = Field(min_length=1, max_length=500)
    matched_grant_id: str | None = None
