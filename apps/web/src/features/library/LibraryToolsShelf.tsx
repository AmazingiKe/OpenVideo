import { type FormEvent, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Download, FolderInput, KeyRound, Wrench } from "lucide-react";

import { RESOURCE_QUERY_KEYS } from "@/app/query_cache";
import { use_task_manager } from "@/app/task_manager";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { DownloadAccountsCard } from "@/features/downloads/DownloadAccountsCard";
import { OnlineDownloadTool } from "@/features/downloads/OnlineDownloadTool";
import { FolderImportDialog } from "@/features/library/FolderImportDialog";
import {
  create_download_account_login_session,
  delete_download_account_login_session,
  delete_download_account,
  get_download_accounts,
  get_health,
  import_download_account_from_browser,
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

type LibraryTool = "accounts" | "download" | "folder_import";

export function LibraryToolsShelf() {
  const query_client = useQueryClient();
  const { start_downloads } = use_task_manager();
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
  const [page_error, set_page_error] = useState<string | null>(null);
  const [active_tool, set_active_tool] = useState<LibraryTool | null>(null);
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

  const download_error =
    page_error ??
    resource_error(health_query.error) ??
    resource_error(folders_query.error);
  const account_query_error = resource_error(download_accounts_query.error);

  return (
    <>
      <div
        className="flex shrink-0 items-center gap-2 rounded-xl border bg-card px-3 py-2"
        role="toolbar"
        aria-label="视频库工具"
      >
        <span className="mr-auto flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <Wrench className="size-4" aria-hidden="true" />
          工具
        </span>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          onClick={() => set_active_tool("download")}
          aria-label="解析并下载在线视频"
          title="解析下载"
        >
          <Download />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          onClick={() => set_active_tool("accounts")}
          aria-label="管理下载平台账号"
          title="平台账号"
        >
          <KeyRound />
        </Button>
        <Button
          type="button"
          size="icon-sm"
          variant="outline"
          onClick={() => set_active_tool("folder_import")}
          aria-label="从文件夹导入视频"
          title="文件夹导入"
        >
          <FolderInput />
        </Button>
      </div>

      <Dialog
        open={active_tool === "download"}
        onOpenChange={(open) => {
          if (!open && !is_submitting) set_active_tool(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-5xl">
          <DialogHeader>
            <DialogTitle>解析下载</DialogTitle>
            <DialogDescription>
              解析视频或播放列表，选择内容后加入后台下载队列。
            </DialogDescription>
          </DialogHeader>
          <OnlineDownloadTool
            health={health}
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
            error={download_error}
            on_source_url_change={set_source_url}
            on_submit_probe={submit_source_probe}
            on_toggle_url={toggle_url}
            on_replace_selection={(urls) => set_selected_urls(new Set(urls))}
            on_target_folder_change={set_target_folder_id}
            on_video_quality_change={set_video_quality}
            on_start_download={() => void start_selected_downloads()}
          />
        </DialogContent>
      </Dialog>

      <Dialog
        open={active_tool === "accounts"}
        onOpenChange={(open) => {
          if (!open && !account_loading_platform) set_active_tool(null);
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-3xl">
          <DialogHeader>
            <DialogTitle>平台账号</DialogTitle>
            <DialogDescription>
              管理 Bilibili、抖音和 YouTube 的下载登录状态。
            </DialogDescription>
          </DialogHeader>
          {account_query_error ? (
            <Alert variant="destructive">
              <AlertTitle>无法读取平台账号</AlertTitle>
              <AlertDescription>{account_query_error}</AlertDescription>
            </Alert>
          ) : null}
          <DownloadAccountsCard
            accounts={download_accounts}
            loading_platform={account_loading_platform}
            errors={account_errors}
            on_save={save_platform_account}
            on_login={login_platform_account}
            on_cancel_login={cancel_platform_account_login}
            on_import_browser={import_platform_account}
            on_test={test_platform_account}
            on_disconnect={disconnect_platform_account}
          />
        </DialogContent>
      </Dialog>

      <FolderImportDialog
        open={active_tool === "folder_import"}
        on_open_change={(open) =>
          set_active_tool(open ? "folder_import" : null)
        }
      />
    </>
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
