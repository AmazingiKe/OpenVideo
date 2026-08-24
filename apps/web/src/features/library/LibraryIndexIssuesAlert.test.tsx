import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LibraryIndexIssuesAlert } from "@/features/library/LibraryIndexIssuesAlert";

describe("LibraryIndexIssuesAlert", () => {
  it("shows only the relative path and keeps the warning non-blocking", () => {
    render(
      <LibraryIndexIssuesAlert
        issues={[
          {
            asset_id: null,
            relative_path: "assets/not-a-uuid",
            code: "invalid_asset_id",
            message: "素材目录名必须是 UUIDv7",
          },
        ]}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent("assets/not-a-uuid");
    expect(screen.queryByText(/^[A-Z]:\\/)).not.toBeInTheDocument();
  });

  it("renders nothing when the index is healthy", () => {
    const { container } = render(<LibraryIndexIssuesAlert issues={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});
