import { get_download_account_login_session } from "./api";
import type { DownloadAccountLoginSession } from "./types";

const LOGIN_POLL_INTERVAL_MS = 1_000;
const MAX_LOGIN_POLL_ATTEMPTS = 6 * 60;
const TERMINAL_LOGIN_STAGES = new Set(["complete", "failed", "cancelled"]);

export async function poll_download_account_login(
  initial_session: DownloadAccountLoginSession,
  signal: AbortSignal,
): Promise<DownloadAccountLoginSession> {
  let current_session = initial_session;
  for (let attempt = 0; attempt < MAX_LOGIN_POLL_ATTEMPTS; attempt += 1) {
    if (TERMINAL_LOGIN_STAGES.has(current_session.stage)) {
      return current_session;
    }
    await wait_for_login_poll(signal);
    current_session = await get_download_account_login_session(
      current_session.login_id,
      signal,
    );
  }
  throw new Error("等待账号登录超时，请重新连接");
}

function wait_for_login_poll(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("请求已取消", "AbortError"));
      return;
    }
    const cancel_poll = () => {
      window.clearTimeout(timeout);
      reject(new DOMException("请求已取消", "AbortError"));
    };
    const timeout = window.setTimeout(() => {
      signal.removeEventListener("abort", cancel_poll);
      resolve();
    }, LOGIN_POLL_INTERVAL_MS);
    signal.addEventListener("abort", cancel_poll, { once: true });
  });
}
