"""确定性 Agent 权限决策，模型只能申请而不能自行授权。"""

from __future__ import annotations

from collections.abc import Iterable

from openvideo.core.agent_governance_models import (
    AgentPermissionContext,
    AgentPermissionDecision,
    AgentPermissionGrant,
    AgentPermissionGrantScope,
    AgentPermissionMode,
    AgentPermissionOutcome,
    AgentToolEffect,
    AgentToolPermissionPolicy,
)


class PermissionPolicy:
    @staticmethod
    def decide(
        mode: AgentPermissionMode,
        tool_policy: AgentToolPermissionPolicy,
        context: AgentPermissionContext,
        grants: Iterable[AgentPermissionGrant] = (),
    ) -> AgentPermissionDecision:
        if not tool_policy.enabled:
            return AgentPermissionDecision(
                outcome=AgentPermissionOutcome.DENY,
                reason="该工具能力已被程序策略禁用",
            )
        if tool_policy.effect == AgentToolEffect.READ:
            return AgentPermissionDecision(
                outcome=AgentPermissionOutcome.ALLOW,
                reason="只读操作不需要额外批准",
            )
        for grant in grants:
            if PermissionPolicy._grant_matches(grant, tool_policy, context):
                return AgentPermissionDecision(
                    outcome=AgentPermissionOutcome.ALLOW,
                    reason="已有授权覆盖本次操作",
                    matched_grant_id=grant.grant_id,
                )
        if mode == AgentPermissionMode.REQUEST_APPROVAL:
            return AgentPermissionDecision(
                outcome=AgentPermissionOutcome.ASK,
                reason="请求批准模式要求确认所有写入或外部操作",
            )
        if mode == AgentPermissionMode.FULL_ACCESS:
            return AgentPermissionDecision(
                outcome=AgentPermissionOutcome.ALLOW,
                reason="完全访问模式允许程序策略范围内的操作",
            )
        high_risk = (
            tool_policy.effect in {AgentToolEffect.DELETE, AgentToolEffect.EXTERNAL}
            or not tool_policy.reversible
            or tool_policy.bulk
        )
        return AgentPermissionDecision(
            outcome=(
                AgentPermissionOutcome.ASK
                if high_risk
                else AgentPermissionOutcome.ALLOW
            ),
            reason=(
                "智能批准模式要求确认高风险操作"
                if high_risk
                else "智能批准模式允许可撤销的普通修改"
            ),
        )

    @staticmethod
    def _grant_matches(
        grant: AgentPermissionGrant,
        tool_policy: AgentToolPermissionPolicy,
        context: AgentPermissionContext,
    ) -> bool:
        if (
            grant.capability != tool_policy.capability
            or grant.resource_scope != tool_policy.resource_scope
            or (
                grant.resource_id is not None
                and grant.resource_id != context.resource_id
            )
        ):
            return False
        if grant.scope == AgentPermissionGrantScope.ONCE:
            return grant.request_id == context.request_id
        if grant.scope == AgentPermissionGrantScope.SESSION:
            return grant.session_id == context.session_id
        return grant.scope == AgentPermissionGrantScope.ALWAYS
