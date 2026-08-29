import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentMarkdown } from "./AgentMarkdown";

describe("AgentMarkdown", () => {
  it("renders useful Markdown while dropping arbitrary HTML", () => {
    const { container } = render(
      <AgentMarkdown
        content={"## 结论\n\n- 第一项\n- 第二项\n\n<script>danger()</script>"}
      />,
    );

    expect(screen.getByRole("heading", { name: "结论" })).toBeVisible();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(container.querySelector("script")).toBeNull();
    expect(screen.queryByText("danger()")).not.toBeInTheDocument();
  });

  it("renders formulas from inline and block delimiters", () => {
    const { container } = render(
      <AgentMarkdown content={"行内 \\(x^2\\)\n\n\\[\ny = x + 1\n\\]"} />,
    );

    expect(container.querySelector(".katex")).toBeInTheDocument();
    expect(container.querySelector(".katex-display")).toBeInTheDocument();
  });
});
