import { describe, expect, it } from "vitest";

import {
  extract_markdown_headings,
  normalize_math_delimiters,
} from "./markdown_document";

describe("normalize_math_delimiters", () => {
  it("兼容 LaTeX 行内与块级分隔符", () => {
    expect(
      normalize_math_delimiters("行内 \\(x^2\\)\n\n\\[\nE = mc^2\n\\]\n"),
    ).toBe("行内 $x^2$\n\n$$\nE = mc^2\n$$\n");
  });

  it("不改写代码围栏与行内代码", () => {
    expect(normalize_math_delimiters("`\\(code\\)`\n\n```md\n\\[\n```\n")).toBe(
      "`\\(code\\)`\n\n```md\n\\[\n```\n",
    );
  });
});

describe("extract_markdown_headings", () => {
  it("提取层级、重复标题和 Setext 标题", () => {
    expect(
      extract_markdown_headings(
        "# 课程 [标题](https://example.com)\n\n## 小节\n\n## 小节\n\n结论\n---\n",
      ),
    ).toEqual([
      { id: "课程-标题", level: 1, line: 1, title: "课程 标题" },
      { id: "小节", level: 2, line: 3, title: "小节" },
      { id: "小节-#2", level: 2, line: 5, title: "小节" },
      { id: "结论", level: 2, line: 7, title: "结论" },
    ]);
  });

  it("忽略代码围栏内的伪标题", () => {
    expect(extract_markdown_headings("```md\n# 不是标题\n```\n# 标题")).toEqual(
      [{ id: "标题", level: 1, line: 4, title: "标题" }],
    );
  });
});
