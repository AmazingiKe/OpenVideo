"""Agent 写入在最新版上执行确定性的三方合并。"""

from __future__ import annotations

from dataclasses import dataclass
from difflib import SequenceMatcher


@dataclass(frozen=True)
class MarkdownMergeResult:
    markdown: str
    rebased: bool
    applied_change_count: int
    skipped_conflicts: tuple[str, ...]


@dataclass(frozen=True)
class _LineChange:
    start: int
    end: int
    replacement: tuple[str, ...]


def merge_markdown(base: str, proposed: str, latest: str) -> MarkdownMergeResult:
    """把 Agent 对基础正文的修改移植到最新版，重叠区保持最新版不变。"""

    proposed_changes = _line_changes(base, proposed)
    if latest == base:
        return MarkdownMergeResult(proposed, False, len(proposed_changes), ())
    if not proposed_changes:
        return MarkdownMergeResult(latest, True, 0, ())

    latest_changes = _line_changes(base, latest)
    applicable: list[_LineChange] = []
    conflicts: list[str] = []
    for position, change in enumerate(proposed_changes, start=1):
        if any(_changes_overlap(change, current) for current in latest_changes):
            conflicts.append(f"摘要修改 {position} 与最新版重叠")
        else:
            applicable.append(change)

    merged = latest.splitlines(keepends=True)
    for change in reversed(applicable):
        start = _latest_position(change.start, latest_changes)
        end = _latest_position(change.end, latest_changes)
        merged[start:end] = change.replacement
    return MarkdownMergeResult(
        "".join(merged),
        True,
        len(applicable),
        tuple(conflicts),
    )


def _line_changes(base: str, changed: str) -> list[_LineChange]:
    base_lines = base.splitlines(keepends=True)
    changed_lines = changed.splitlines(keepends=True)
    matcher = SequenceMatcher(a=base_lines, b=changed_lines, autojunk=False)
    return [
        _LineChange(start, end, tuple(changed_lines[new_start:new_end]))
        for operation, start, end, new_start, new_end in matcher.get_opcodes()
        if operation != "equal"
    ]


def _changes_overlap(first: _LineChange, second: _LineChange) -> bool:
    first_insert = first.start == first.end
    second_insert = second.start == second.end
    if first_insert and second_insert:
        return first.start == second.start
    if first_insert:
        return second.start <= first.start <= second.end
    if second_insert:
        return first.start <= second.start <= first.end
    return max(first.start, second.start) < min(first.end, second.end)


def _latest_position(position: int, changes: list[_LineChange]) -> int:
    offset = 0
    for change in changes:
        if change.end > position:
            break
        offset += len(change.replacement) - (change.end - change.start)
    return position + offset
