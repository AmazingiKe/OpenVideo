import { act, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { probe_backend } from "@/shared/api";
import { BackendConnectionGate } from "./backend_connection";

vi.mock("@/shared/api", () => ({
  probe_backend: vi.fn(),
}));

function StatefulWorkspace() {
  const [count, set_count] = useState(0);
  return (
    <button type="button" onClick={() => set_count((current) => current + 1)}>
      工作区计数 {count}
    </button>
  );
}

describe("BackendConnectionGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("blocks the workspace until the backend responds", async () => {
    vi.mocked(probe_backend).mockRejectedValueOnce(new TypeError("offline"));

    render(
      <BackendConnectionGate>
        <StatefulWorkspace />
      </BackendConnectionGate>,
    );
    await act(async () => undefined);

    expect(
      screen.getByRole("heading", { name: "后端未启动" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("retries after three seconds and restores preserved workspace state", async () => {
    vi.mocked(probe_backend)
      .mockResolvedValueOnce({ status: "ready" })
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce({ status: "ready" });

    render(
      <BackendConnectionGate>
        <StatefulWorkspace />
      </BackendConnectionGate>,
    );
    await act(async () => undefined);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toHaveTextContent("工作区计数 1");

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(
      screen.getByRole("heading", { name: "后端未启动" }),
    ).toBeInTheDocument();

    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(screen.getByRole("button")).toHaveTextContent("工作区计数 1");
  });
});
