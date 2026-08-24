import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "./api";
import { poll_download_account_login } from "./poll_download_account_login";
import type { DownloadAccountLoginSession } from "./types";

const waiting_session: DownloadAccountLoginSession = {
  login_id: "login-0198d12345677890abcdef1234567890",
  platform: "douyin",
  stage: "waiting",
  message: "请完成登录",
  account: null,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("poll_download_account_login", () => {
  it("轮询到登录完成为止", async () => {
    vi.useFakeTimers();
    const complete_session = {
      ...waiting_session,
      stage: "complete" as const,
      message: "登录成功",
    };
    vi.spyOn(api, "get_download_account_login_session").mockResolvedValueOnce(
      complete_session,
    );

    const promise = poll_download_account_login(
      waiting_session,
      new AbortController().signal,
    );
    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual(complete_session);
    expect(api.get_download_account_login_session).toHaveBeenCalledTimes(1);
  });

  it("已取消时不发送轮询请求", async () => {
    const controller = new AbortController();
    controller.abort();
    const get_session = vi.spyOn(api, "get_download_account_login_session");

    await expect(
      poll_download_account_login(waiting_session, controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(get_session).not.toHaveBeenCalled();
  });
});
