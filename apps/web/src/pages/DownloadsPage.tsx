import { type FormEvent, useEffect, useState } from "react";

import { use_task_manager } from "@/app/task_manager";
import { DownloadWorkspace } from "@/features/workbench/DownloadWorkspace";
import {
  delete_download_account,
  get_download_accounts,
  get_health,
  import_download_account_from_browser,
  probe_source,
  save_download_account,
  test_download_account,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import type {
  DownloadAccount,
  DownloadCookieBrowser,
  HealthResponse,
  ProbeEntry,
  ProbeResponse,
  SourcePlatform,
} from "@/shared/types";

const DOUYIN_VIDEO_HOSTS = new Set([
  "douyin.com",
  "www.douyin.com",
  "m.douyin.com",
]);
const DOUYIN_VIDEO_PATH = "video";
const DOUYIN_SEARCH_PATH = "search/dy";
const DOUYIN_MODAL_VIDEO_ID_PARAMETER = "modal_id";

export function DownloadsPage() {
  const { task_records, start_downloads } = use_task_manager();
  const [health, set_health] = useState<HealthResponse | null>(null);
  const [source_url, set_source_url] = useState("");
  const [probe_result, set_probe_result] = useState<ProbeResponse | null>(null);
  const [selected_urls, set_selected_urls] = useState<Set<string>>(new Set());
  const [is_submitting, set_is_submitting] = useState(false);
  const [page_error, set_page_error] = useState<string | null>(null);
  const [download_accounts, set_download_accounts] = useState<
    DownloadAccount[]
  >([]);
  const [account_loading_platform, set_account_loading_platform] =
    useState<SourcePlatform | null>(null);
  const [account_errors, set_account_errors] = useState<
    Partial<Record<SourcePlatform, string>>
  >({});

  useEffect(() => {
    const controller = new AbortController();
    void get_health(controller.signal)
      .then(set_health)
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_page_error(error_message(error));
      });
    void get_download_accounts(controller.signal)
      .then(set_download_accounts)
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_page_error(error_message(error));
      });
    return () => controller.abort();
  }, []);

  async function submit_source_probe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalized_url = source_url.trim();
    if (!normalized_url) {
      set_page_error("请先粘贴 Bilibili、抖音或 YouTube 视频地址");
      return;
    }
    set_is_submitting(true);
    set_page_error(null);
    try {
      const probe = await probe_source(normalized_url);
      set_probe_result(probe);
      set_selected_urls(initial_selected_urls(probe.entries, normalized_url));
    } catch (error) {
      if (!is_abort_error(error)) {
        set_page_error(error_message(error));
        await refresh_download_accounts();
      }
    } finally {
      set_is_submitting(false);
    }
  }

  async function start_selected_downloads() {
    const urls = [...selected_urls];
    if (urls.length === 0) {
      set_page_error("请至少选择一个视频");
      return;
    }
    set_is_submitting(true);
    set_page_error(null);
    try {
      const final_jobs = await start_downloads(urls);
      set_probe_result(null);
      set_selected_urls(new Set());
      if (final_jobs.some((job) => job.stage === "complete"))
        set_source_url("");
      const failed_job = final_jobs.find((job) => job.stage === "failed");
      if (failed_job)
        set_page_error(failed_job.error_message ?? "部分视频下载失败");
      if (failed_job) await refresh_download_accounts();
    } catch (error) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_submitting(false);
    }
  }

  async function save_platform_account(
    platform: SourcePlatform,
    cookie: string,
  ) {
    set_account_loading_platform(platform);
    clear_account_error(platform);
    try {
      update_download_account(await save_download_account(platform, cookie));
    } catch (error) {
      if (!is_abort_error(error))
        set_account_error(platform, error_message(error));
      throw error;
    } finally {
      set_account_loading_platform(null);
    }
  }

  async function import_platform_account(
    platform: SourcePlatform,
    browser: DownloadCookieBrowser,
  ) {
    set_account_loading_platform(platform);
    clear_account_error(platform);
    try {
      const test_url =
        source_platform_from_url(source_url) === platform
          ? source_url.trim()
          : undefined;
      update_download_account(
        await import_download_account_from_browser(platform, browser, test_url),
      );
    } catch (error) {
      if (!is_abort_error(error))
        set_account_error(platform, error_message(error));
      throw error;
    } finally {
      set_account_loading_platform(null);
    }
  }

  async function test_platform_account(platform: SourcePlatform) {
    set_account_loading_platform(platform);
    clear_account_error(platform);
    try {
      const test_url =
        source_platform_from_url(source_url) === platform
          ? source_url.trim()
          : undefined;
      update_download_account(await test_download_account(platform, test_url));
    } catch (error) {
      if (!is_abort_error(error))
        set_account_error(platform, error_message(error));
      await refresh_download_accounts();
    } finally {
      set_account_loading_platform(null);
    }
  }

  async function disconnect_platform_account(platform: SourcePlatform) {
    set_account_loading_platform(platform);
    clear_account_error(platform);
    try {
      await delete_download_account(platform);
      set_download_accounts((current) =>
        current.filter((account) => account.platform !== platform),
      );
    } catch (error) {
      if (!is_abort_error(error))
        set_account_error(platform, error_message(error));
    } finally {
      set_account_loading_platform(null);
    }
  }

  async function refresh_download_accounts() {
    try {
      set_download_accounts(await get_download_accounts());
    } catch (error) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    }
  }

  function update_download_account(updated_account: DownloadAccount) {
    set_download_accounts((current) => [
      ...current.filter(
        (account) => account.platform !== updated_account.platform,
      ),
      updated_account,
    ]);
  }

  function set_account_error(platform: SourcePlatform, message: string) {
    set_account_errors((current) => ({ ...current, [platform]: message }));
  }

  function clear_account_error(platform: SourcePlatform) {
    set_account_errors((current) => {
      const next = { ...current };
      delete next[platform];
      return next;
    });
  }

  function toggle_url(url: string) {
    set_selected_urls((current) => {
      const next = new Set(current);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }

  return (
    <DownloadWorkspace
      health={health}
      task_records={task_records}
      source_url={source_url}
      probe_result={probe_result}
      selected_urls={selected_urls}
      current_source_video_id={source_video_id_from_url(source_url)}
      is_submitting={is_submitting}
      error={page_error}
      download_accounts={download_accounts}
      account_loading_platform={account_loading_platform}
      account_errors={account_errors}
      on_source_url_change={set_source_url}
      on_submit_probe={submit_source_probe}
      on_toggle_url={toggle_url}
      on_replace_selection={(urls) => set_selected_urls(new Set(urls))}
      on_start_download={() => void start_selected_downloads()}
      on_save_download_account={save_platform_account}
      on_import_download_account={import_platform_account}
      on_test_download_account={test_platform_account}
      on_disconnect_download_account={disconnect_platform_account}
    />
  );
}

function source_platform_from_url(source_url: string): SourcePlatform | null {
  try {
    const hostname = new URL(source_url.trim()).hostname;
    if (DOUYIN_VIDEO_HOSTS.has(hostname)) return "douyin";
    if (hostname.endsWith("bilibili.com") || hostname === "b23.tv")
      return "bilibili";
    if (hostname.endsWith("youtube.com") || hostname === "youtu.be")
      return "youtube";
    return null;
  } catch {
    return null;
  }
}

function initial_selected_urls(
  entries: ProbeEntry[],
  source_url: string,
): Set<string> {
  const source_video_id = source_video_id_from_url(source_url);
  const current_entry = entries.find(
    (entry) => entry.source_video_id === source_video_id,
  );
  return current_entry ? new Set([current_entry.url]) : new Set();
}

function source_video_id_from_url(source_url: string): string | null {
  try {
    const url = new URL(source_url);
    const path_parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname.endsWith("youtube.com")) return url.searchParams.get("v");
    if (url.hostname === "youtu.be") return path_parts[0] ?? null;
    if (url.hostname.endsWith("bilibili.com") || url.hostname === "b23.tv")
      return path_parts.at(-1) ?? null;
    if (DOUYIN_VIDEO_HOSTS.has(url.hostname)) {
      if (path_parts[0] === DOUYIN_VIDEO_PATH) return path_parts[1] ?? null;
      if (path_parts.join("/") === DOUYIN_SEARCH_PATH)
        return url.searchParams.get(DOUYIN_MODAL_VIDEO_ID_PARAMETER);
    }
  } catch {
    return null;
  }
  return null;
}
