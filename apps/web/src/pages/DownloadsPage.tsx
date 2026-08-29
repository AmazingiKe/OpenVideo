import { type FormEvent, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { use_task_manager } from "@/app/task_manager";
import type { VideoImportState } from "@/features/downloads/VideoImportCard";
import { DownloadWorkspace } from "@/features/workbench/DownloadWorkspace";
import {
  create_download_account_login_session,
  delete_download_account_login_session,
  delete_download_account,
  get_download_accounts,
  get_health,
  import_download_account_from_browser,
  import_local_video,
  list_folders,
  probe_source,
  save_download_account,
  test_download_account,
} from "@/shared/api";
import { error_message, is_abort_error } from "@/shared/errors";
import { poll_download_account_login } from "@/shared/poll_download_account_login";
import type {
  DownloadAccount,
  DownloadCookieBrowser,
  DownloadFolderSelection,
  DownloadQuality,
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
const BILIBILI_HOST_SUFFIX = "bilibili.com";
const BILIBILI_SHORT_HOST = "b23.tv";
const BILIBILI_PART_PARAMETER = "p";
const BILIBILI_PART_ID_SEPARATOR = "_p";
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;

export function DownloadsPage() {
  const query_client = useQueryClient();
  const { task_records, start_downloads, retry_download } = use_task_manager();
  const health_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.download_health,
    queryFn: ({ signal }) => get_health(signal),
  });
  const download_accounts_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.download_accounts,
    queryFn: ({ signal }) => get_download_accounts(signal),
  });
  const folders_query = useQuery({
    queryKey: RESOURCE_QUERY_KEYS.library_folders,
    queryFn: ({ signal }) => list_folders(signal),
  });
  const health: HealthResponse | null = health_query.data ?? null;
  const download_accounts = download_accounts_query.data ?? [];
  const [source_url, set_source_url] = useState("");
  const [probe_result, set_probe_result] = useState<ProbeResponse | null>(null);
  const [selected_urls, set_selected_urls] = useState<Set<string>>(new Set());
  const [target_folder_id, set_target_folder_id] =
    useState<DownloadFolderSelection>(undefined);
  const [video_quality, set_video_quality] = useState<DownloadQuality>("best");
  const [is_submitting, set_is_submitting] = useState(false);
  const [retrying_download_task_id, set_retrying_download_task_id] = useState<
    string | null
  >(null);
  const [page_error, set_page_error] = useState<string | null>(null);
  const [video_import_state, set_video_import_state] =
    useState<VideoImportState>({ stage: "idle" });
  const [account_loading_platform, set_account_loading_platform] =
    useState<SourcePlatform | null>(null);
  const [account_errors, set_account_errors] = useState<
    Partial<Record<SourcePlatform, string>>
  >({});
  const account_login_session_ids = useRef<
    Partial<Record<SourcePlatform, string>>
  >({});
  const account_login_controllers = useRef<
    Partial<Record<SourcePlatform, AbortController>>
  >({});
  const account_login_cancel_requested = useRef<
    Partial<Record<SourcePlatform, boolean>>
  >({});

  useEffect(() => {
    const login_controllers = account_login_controllers.current;
    const login_session_ids = account_login_session_ids.current;
    const login_cancel_requested = account_login_cancel_requested.current;
    return () => {
      for (const [platform, login_controller] of Object.entries(
        login_controllers,
      )) {
        login_cancel_requested[platform as SourcePlatform] = true;
        login_controller.abort();
      }
      for (const login_id of Object.values(login_session_ids)) {
        void delete_download_account_login_session(login_id).catch(
          () => undefined,
        );
      }
    };
  }, []);

  async function submit_source_probe(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    set_probe_result(null);
    set_selected_urls(new Set());

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
      const automatic_folder_name =
        target_folder_id === undefined && probe_result?.is_playlist
          ? probe_result.title
          : null;
      const final_jobs = await start_downloads(urls, {
        video_quality,
        folder_id: target_folder_id ?? null,
        automatic_folder_name,
        assign_folder:
          target_folder_id !== undefined || automatic_folder_name !== null,
      });
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

  async function import_dropped_video(file: File) {
    set_video_import_state({ stage: "importing", filename: file.name });
    try {
      const asset = await import_local_video(file);
      await query_client.invalidateQueries({
        queryKey: RESOURCE_QUERY_KEYS.assets,
      });
      set_video_import_state({ stage: "complete", title: asset.title });
    } catch (error) {
      if (!is_abort_error(error)) {
        set_video_import_state({
          stage: "failed",
          message: error_message(error),
        });
      }
    }
  }

  async function retry_failed_download(task_id: string) {
    set_retrying_download_task_id(task_id);
    set_page_error(null);
    try {
      const final_job = await retry_download(task_id);
      if (final_job.stage === "failed") {
        set_page_error(final_job.error_message ?? "重新下载失败");
        await refresh_download_accounts();
      }
    } catch (error) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_retrying_download_task_id((current) =>
        current === task_id ? null : current,
      );
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

  async function login_platform_account(platform: SourcePlatform) {
    set_account_loading_platform(platform);
    clear_account_error(platform);
    const controller = new AbortController();
    account_login_controllers.current[platform] = controller;
    account_login_cancel_requested.current[platform] = false;
    let login_id: string | null = null;
    try {
      const initial_session =
        await create_download_account_login_session(platform);
      login_id = initial_session.login_id;
      account_login_session_ids.current[platform] = login_id;
      if (account_login_cancel_requested.current[platform]) {
        await delete_download_account_login_session(login_id);
        login_id = null;
        throw new DOMException("请求已取消", "AbortError");
      }
      const final_session = await poll_download_account_login(
        initial_session,
        controller.signal,
      );
      if (final_session.stage !== "complete" || !final_session.account) {
        throw new Error(final_session.message);
      }
      update_download_account(final_session.account);
    } catch (error) {
      if (!is_abort_error(error))
        set_account_error(platform, error_message(error));
      throw error;
    } finally {
      if (login_id) {
        try {
          await delete_download_account_login_session(login_id);
        } catch {
          // 会话可能已由取消操作清理，账号结果不受清理请求影响。
        }
      }
      delete account_login_session_ids.current[platform];
      delete account_login_controllers.current[platform];
      delete account_login_cancel_requested.current[platform];
      set_account_loading_platform((current) =>
        current === platform ? null : current,
      );
    }
  }

  async function cancel_platform_account_login(platform: SourcePlatform) {
    account_login_cancel_requested.current[platform] = true;
    account_login_controllers.current[platform]?.abort();
    const login_id = account_login_session_ids.current[platform];
    if (login_id) {
      try {
        await delete_download_account_login_session(login_id);
      } catch {
        // 登录任务完成和用户取消可能同时发生，重复清理可以安全忽略。
      }
    }
    set_account_loading_platform((current) =>
      current === platform ? null : current,
    );
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
      query_client.setQueryData<DownloadAccount[]>(
        RESOURCE_QUERY_KEYS.download_accounts,
        (current) =>
          (current ?? []).filter((account) => account.platform !== platform),
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
      query_client.setQueryData(
        RESOURCE_QUERY_KEYS.download_accounts,
        await get_download_accounts(),
      );
    } catch (error) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    }
  }

  function update_download_account(updated_account: DownloadAccount) {
    query_client.setQueryData<DownloadAccount[]>(
      RESOURCE_QUERY_KEYS.download_accounts,
      (current) => [
        ...(current ?? []).filter(
          (account) => account.platform !== updated_account.platform,
        ),
        updated_account,
      ],
    );
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
      folders={folders_query.data ?? []}
      target_folder_id={target_folder_id}
      video_quality={video_quality}
      current_source_video_id={
        current_probe_entry(probe_result?.entries ?? [], source_url)
          ?.source_video_id ?? null
      }
      is_submitting={is_submitting}
      retrying_download_task_id={retrying_download_task_id}
      error={
        page_error ??
        resource_error(health_query.error) ??
        resource_error(download_accounts_query.error) ??
        resource_error(folders_query.error)
      }
      download_accounts={download_accounts}
      account_loading_platform={account_loading_platform}
      account_errors={account_errors}
      video_import_state={video_import_state}
      on_source_url_change={set_source_url}
      on_submit_probe={submit_source_probe}
      on_toggle_url={toggle_url}
      on_replace_selection={(urls) => set_selected_urls(new Set(urls))}
      on_target_folder_change={set_target_folder_id}
      on_video_quality_change={set_video_quality}
      on_start_download={() => void start_selected_downloads()}
      on_retry_download={(task_id) => void retry_failed_download(task_id)}
      on_save_download_account={save_platform_account}
      on_login_download_account={login_platform_account}
      on_cancel_download_account_login={cancel_platform_account_login}
      on_import_download_account={import_platform_account}
      on_test_download_account={test_platform_account}
      on_disconnect_download_account={disconnect_platform_account}
      on_video_drop={(file) => void import_dropped_video(file)}
      on_invalid_video_drop={(message) =>
        set_video_import_state({ stage: "failed", message })
      }
    />
  );
}

function resource_error(error: Error | null): string | null {
  return error ? error_message(error) : null;
}

function source_platform_from_url(source_url: string): SourcePlatform | null {
  try {
    const hostname = new URL(source_url.trim()).hostname;
    if (DOUYIN_VIDEO_HOSTS.has(hostname)) return "douyin";
    if (
      hostname.endsWith(BILIBILI_HOST_SUFFIX) ||
      hostname === BILIBILI_SHORT_HOST
    )
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
  const current_entry = current_probe_entry(entries, source_url);
  return current_entry ? new Set([current_entry.url]) : new Set();
}

function current_probe_entry(
  entries: ProbeEntry[],
  source_url: string,
): ProbeEntry | null {
  const source_video_id = source_video_id_from_url(source_url);
  if (!source_video_id) return null;
  try {
    const url = new URL(source_url);
    if (url.hostname.endsWith(BILIBILI_HOST_SUFFIX)) {
      const raw_part_number = url.searchParams.get(BILIBILI_PART_PARAMETER);
      const part_number =
        raw_part_number && POSITIVE_INTEGER_PATTERN.test(raw_part_number)
          ? Number(raw_part_number)
          : 1;
      const part_source_video_id = `${source_video_id}${BILIBILI_PART_ID_SEPARATOR}${part_number}`;
      const part_entry = entries.find(
        (entry) => entry.source_video_id === part_source_video_id,
      );
      if (part_entry) return part_entry;
    }
  } catch {
    return null;
  }
  return (
    entries.find((entry) => entry.source_video_id === source_video_id) ?? null
  );
}

function source_video_id_from_url(source_url: string): string | null {
  try {
    const url = new URL(source_url);
    const path_parts = url.pathname.split("/").filter(Boolean);
    if (url.hostname.endsWith("youtube.com")) return url.searchParams.get("v");
    if (url.hostname === "youtu.be") return path_parts[0] ?? null;
    if (
      url.hostname.endsWith(BILIBILI_HOST_SUFFIX) ||
      url.hostname === BILIBILI_SHORT_HOST
    )
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
