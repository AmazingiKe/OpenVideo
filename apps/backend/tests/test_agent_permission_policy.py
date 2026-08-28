from __future__ import annotations

import itertools

import pytest

from openvideo.agent_permission_policy import PermissionPolicy
from openvideo.core.agent_governance_models import (
    AgentPermissionContext,
    AgentPermissionGrant,
    AgentPermissionGrantScope,
    AgentPermissionMode,
    AgentPermissionOutcome,
    AgentResourceScope,
    AgentToolEffect,
    AgentToolPermissionPolicy,
)
from openvideo.core.identifiers import uuid7


REQUEST_ID = f"request-{uuid7().hex}"
SESSION_ID = f"session-{uuid7().hex}"
OTHER_REQUEST_ID = f"request-{uuid7().hex}"
OTHER_SESSION_ID = f"session-{uuid7().hex}"
CONTEXT = AgentPermissionContext(
    request_id=REQUEST_ID,
    session_id=SESSION_ID,
    resource_id="asset-current",
)


def policy(
    effect: AgentToolEffect,
    *,
    reversible: bool = True,
    bulk: bool = False,
    enabled: bool = True,
) -> AgentToolPermissionPolicy:
    return AgentToolPermissionPolicy(
        capability="summary.edit",
        effect=effect,
        resource_scope=AgentResourceScope.CURRENT_ITEM,
        reversible=reversible,
        bulk=bulk,
        enabled=enabled,
    )


@pytest.mark.parametrize("mode", list(AgentPermissionMode))
def test_all_modes_allow_read_only_operations(mode: AgentPermissionMode):
    decision = PermissionPolicy.decide(mode, policy(AgentToolEffect.READ), CONTEXT)

    assert decision.outcome == AgentPermissionOutcome.ALLOW


@pytest.mark.parametrize(
    ("mode", "effect", "reversible", "bulk", "expected"),
    [
        (
            AgentPermissionMode.REQUEST_APPROVAL,
            effect,
            reversible,
            bulk,
            AgentPermissionOutcome.ASK,
        )
        for effect, reversible, bulk in itertools.product(
            (AgentToolEffect.WRITE, AgentToolEffect.DELETE, AgentToolEffect.EXTERNAL),
            (True, False),
            (True, False),
        )
    ]
    + [
        (
            AgentPermissionMode.FULL_ACCESS,
            effect,
            reversible,
            bulk,
            AgentPermissionOutcome.ALLOW,
        )
        for effect, reversible, bulk in itertools.product(
            (AgentToolEffect.WRITE, AgentToolEffect.DELETE, AgentToolEffect.EXTERNAL),
            (True, False),
            (True, False),
        )
    ]
    + [
        (
            AgentPermissionMode.SMART_APPROVAL,
            AgentToolEffect.WRITE,
            True,
            False,
            AgentPermissionOutcome.ALLOW,
        ),
        (
            AgentPermissionMode.SMART_APPROVAL,
            AgentToolEffect.WRITE,
            False,
            False,
            AgentPermissionOutcome.ASK,
        ),
        (
            AgentPermissionMode.SMART_APPROVAL,
            AgentToolEffect.WRITE,
            True,
            True,
            AgentPermissionOutcome.ASK,
        ),
        (
            AgentPermissionMode.SMART_APPROVAL,
            AgentToolEffect.DELETE,
            True,
            False,
            AgentPermissionOutcome.ASK,
        ),
        (
            AgentPermissionMode.SMART_APPROVAL,
            AgentToolEffect.EXTERNAL,
            True,
            False,
            AgentPermissionOutcome.ASK,
        ),
    ],
)
def test_permission_matrix_is_deterministic(
    mode: AgentPermissionMode,
    effect: AgentToolEffect,
    reversible: bool,
    bulk: bool,
    expected: AgentPermissionOutcome,
):
    decision = PermissionPolicy.decide(
        mode,
        policy(effect, reversible=reversible, bulk=bulk),
        CONTEXT,
    )

    assert decision.outcome == expected


def test_disabled_program_policy_cannot_be_overridden_by_full_access_or_grant():
    grant = AgentPermissionGrant(
        capability="summary.edit",
        resource_scope=AgentResourceScope.CURRENT_ITEM,
        scope=AgentPermissionGrantScope.ALWAYS,
    )

    decision = PermissionPolicy.decide(
        AgentPermissionMode.FULL_ACCESS,
        policy(AgentToolEffect.WRITE, enabled=False),
        CONTEXT,
        [grant],
    )

    assert decision.outcome == AgentPermissionOutcome.DENY


@pytest.mark.parametrize(
    ("grant", "matches"),
    [
        (
            AgentPermissionGrant(
                capability="summary.edit",
                resource_scope=AgentResourceScope.CURRENT_ITEM,
                resource_id="asset-current",
                scope=AgentPermissionGrantScope.ONCE,
                request_id=REQUEST_ID,
            ),
            True,
        ),
        (
            AgentPermissionGrant(
                capability="summary.edit",
                resource_scope=AgentResourceScope.CURRENT_ITEM,
                scope=AgentPermissionGrantScope.ONCE,
                request_id=OTHER_REQUEST_ID,
            ),
            False,
        ),
        (
            AgentPermissionGrant(
                capability="summary.edit",
                resource_scope=AgentResourceScope.CURRENT_ITEM,
                scope=AgentPermissionGrantScope.SESSION,
                session_id=SESSION_ID,
            ),
            True,
        ),
        (
            AgentPermissionGrant(
                capability="summary.edit",
                resource_scope=AgentResourceScope.CURRENT_ITEM,
                scope=AgentPermissionGrantScope.SESSION,
                session_id=OTHER_SESSION_ID,
            ),
            False,
        ),
        (
            AgentPermissionGrant(
                capability="summary.edit",
                resource_scope=AgentResourceScope.CURRENT_ITEM,
                scope=AgentPermissionGrantScope.ALWAYS,
            ),
            True,
        ),
        (
            AgentPermissionGrant(
                capability="marker.edit",
                resource_scope=AgentResourceScope.CURRENT_ITEM,
                scope=AgentPermissionGrantScope.ALWAYS,
            ),
            False,
        ),
    ],
)
def test_grants_are_limited_to_their_declared_scope(
    grant: AgentPermissionGrant, matches: bool
):
    decision = PermissionPolicy.decide(
        AgentPermissionMode.REQUEST_APPROVAL,
        policy(AgentToolEffect.WRITE),
        CONTEXT,
        [grant],
    )

    expected = AgentPermissionOutcome.ALLOW if matches else AgentPermissionOutcome.ASK
    assert decision.outcome == expected
    assert (decision.matched_grant_id == grant.grant_id) is matches
