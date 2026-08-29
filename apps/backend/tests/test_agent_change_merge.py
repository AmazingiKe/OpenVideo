from openvideo.core.agent_change_merge import merge_markdown


def test_markdown_merge_preserves_non_conflicting_latest_edit():
    result = merge_markdown(
        "# 标题\n\n旧结论\n\n旧备注\n",
        "# 标题\n\n新结论\n\n旧备注\n",
        "# 标题\n\n旧结论\n\n用户备注\n",
    )

    assert result.markdown == "# 标题\n\n新结论\n\n用户备注\n"
    assert result.rebased is True
    assert result.applied_change_count == 1
    assert result.skipped_conflicts == ()


def test_markdown_merge_keeps_latest_text_for_overlapping_edit():
    result = merge_markdown(
        "# 标题\n\n旧结论\n",
        "# 标题\n\nAgent 结论\n",
        "# 标题\n\n用户结论\n",
    )

    assert result.markdown == "# 标题\n\n用户结论\n"
    assert result.rebased is True
    assert result.applied_change_count == 0
    assert result.skipped_conflicts == ("摘要修改 1 与最新版重叠",)
