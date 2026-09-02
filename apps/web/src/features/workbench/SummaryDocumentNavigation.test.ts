import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import type { SummaryDocument } from "@/shared/types";
import {
  build_document_tree_rows,
  DocumentOutline,
  DocumentTree,
  apply_document_placement,
  document_drop_placement,
} from "./SummaryDocumentNavigation";

const CREATED_AT = "2026-08-30T00:00:00Z";

function document(
  document_id: string,
  parent_document_id: string | null,
  position: number,
): SummaryDocument {
  return {
    document_id,
    asset_id: "asset-1",
    parent_document_id,
    title: document_id,
    markdown: "",
    relative_path: `${document_id}.md`,
    content_digest: "digest",
    position,
    revision: 1,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

const DOCUMENTS = [
  document("root", null, 0),
  document("a", "root", 0),
  document("b", "root", 1),
  document("a-1", "a", 0),
];

describe("build_document_tree_rows", () => {
  it("按父子关系和位置生成三级树", () => {
    expect(
      build_document_tree_rows(DOCUMENTS).map((row) => [
        row.document.document_id,
        row.depth,
      ]),
    ).toEqual([
      ["root", 0],
      ["a", 1],
      ["a-1", 2],
      ["b", 1],
    ]);
  });

  it("隐藏折叠节点的后代", () => {
    expect(
      build_document_tree_rows(DOCUMENTS, new Set(["a"])).map(
        (row) => row.document.document_id,
      ),
    ).toEqual(["root", "a", "b"]);
  });
});

describe("document_drop_placement", () => {
  it("计算同级排序与移入位置", () => {
    expect(document_drop_placement(DOCUMENTS, "b", "a", "before")).toEqual({
      parent_document_id: "root",
      position: 0,
    });
    expect(document_drop_placement(DOCUMENTS, "b", "a", "inside")).toEqual({
      parent_document_id: "a",
      position: 1,
    });
  });

  it("拒绝超过三级或移入自身后代", () => {
    expect(document_drop_placement(DOCUMENTS, "a", "a-1", "inside")).toBeNull();
    expect(document_drop_placement(DOCUMENTS, "b", "a-1", "inside")).toBeNull();
  });
});

describe("apply_document_placement", () => {
  it("在请求完成前同步更新源与目标同级位置", () => {
    expect(
      apply_document_placement(DOCUMENTS, "b", "a", 0).map((document) => [
        document.document_id,
        document.parent_document_id,
        document.position,
      ]),
    ).toEqual([
      ["root", null, 0],
      ["a", "root", 0],
      ["b", "a", 0],
      ["a-1", "a", 1],
    ]);
  });
});

describe("DocumentTree", () => {
  it("支持标准树焦点、键盘打开与 F2 重命名", () => {
    const on_select = vi.fn();
    render(
      createElement(DocumentTree, {
        documents: DOCUMENTS,
        selected_document_id: "root",
        on_select,
        on_create: vi.fn(),
        on_rename: vi.fn(),
        on_duplicate: vi.fn(),
        on_move: vi.fn(),
        reordering: false,
        on_delete: vi.fn(),
      }),
    );

    const root = screen.getByRole("treeitem", { name: "root" });
    const child = screen.getByRole("treeitem", { name: "a" });
    root.focus();
    fireEvent.keyDown(root, { key: "ArrowDown" });
    expect(child).toHaveFocus();
    fireEvent.keyDown(child, { key: "Enter" });
    expect(on_select).toHaveBeenCalledWith("a");
    fireEvent.keyDown(child, { key: "F2" });
    expect(screen.getByRole("textbox", { name: "重命名 a" })).toHaveFocus();
  });
});

describe("DocumentOutline", () => {
  it("展示全部同级标题并按搜索保留祖先路径", () => {
    render(
      createElement(DocumentOutline, {
        markdown: "# 总结\n\n## 甲\n\n### 甲一\n\n### 甲二\n\n## 乙",
        active_heading_id: null,
        on_select: () => undefined,
      }),
    );

    expect(screen.getAllByRole("treeitem")).toHaveLength(5);
    fireEvent.change(screen.getByRole("textbox", { name: "搜索文档大纲" }), {
      target: { value: "甲二" },
    });
    expect(screen.getAllByRole("treeitem")).toHaveLength(3);
    expect(screen.getByRole("treeitem", { name: "总结" })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "甲" })).toBeVisible();
    expect(screen.getByRole("treeitem", { name: "甲二" })).toBeVisible();
  });
});
