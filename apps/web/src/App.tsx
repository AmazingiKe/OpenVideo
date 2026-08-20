import { type FormEvent, useEffect, useRef, useState } from "react";
import { Clapperboard, Download, FileText, ScanSearch } from "lucide-react";

import {
  analyze_asset,
  create_download,
  get_health,
  get_segments,
  get_transcript,
  list_assets,
  probe_source,
  type ApiError,
} from "./shared/api";
import { poll_analysis } from "./shared/poll_analysis";
import { poll_download } from "./shared/poll_download";
import type {
  AnalysisJob,
  DownloadJob,
  HealthResponse,
  MediaAsset,
  MediaSegment,
  ProbeResponse,
  Transcript,
} from "./shared/types";
import { use_asset_markers } from "./features/player/use_asset_markers";
import { type PlayerHandle } from "./features/player/Player";
import { AssetLibrary } from "./features/workbench/AssetLibrary";
import { DownloadWorkspace } from "./features/workbench/DownloadWorkspace";
import { Inspector } from "./features/workbench/Inspector";
import { SummaryWorkspace } from "./features/workbench/SummaryWorkspace";
import { TaskDrawer, type TaskRecord } from "./features/workbench/TaskDrawer";
import { VideoWorkspace } from "./features/workbench/VideoWorkspace";


const terminal_download_stages = new Set(["complete", "failed"]);
const MAX_TASK_RECORDS = 100;
const WORKSPACE_MODULES = [
  { id: "download", label: "视频下载", path: "/downloads", icon: Download },
  { id: "analysis", label: "视频分析", path: "/analysis", icon: ScanSearch },
  { id: "summary", label: "分析总结", path: "/summary", icon: FileText },
] as const;

type WorkspaceModule = (typeof WORKSPACE_MODULES)[number];
type WorkspaceModuleId = WorkspaceModule["id"];

function workspace_module_id_from_path(pathname: string): WorkspaceModuleId {
  return WORKSPACE_MODULES.find((module) => module.path === pathname)?.id ?? "download";
}

export function App() {
  const [health, set_health] = useState<HealthResponse | null>(null);
  const [assets, set_assets] = useState<MediaAsset[]>([]);
  const [selected_asset_id, set_selected_asset_id] = useState<string | null>(null);
  const [task_records, set_task_records] = useState<TaskRecord[]>([]);
  const [segments, set_segments] = useState<MediaSegment[]>([]);
  const [transcript, set_transcript] = useState<Transcript | null>(null);
  const [current_time, set_current_time] = useState(0);
  const [source_url, set_source_url] = useState("");
  const [probe_result, set_probe_result] = useState<ProbeResponse | null>(null);
  const [selected_probe_urls, set_selected_probe_urls] = useState<Set<string>>(new Set());
  const [is_submitting, set_is_submitting] = useState(false);
  const [is_analyzing, set_is_analyzing] = useState(false);
  const [is_task_drawer_open, set_is_task_drawer_open] = useState(false);
  const [page_error, set_page_error] = useState<string | null>(null);
  const [active_workspace_module, set_active_workspace_module] = useState<WorkspaceModuleId>(() => (
    workspace_module_id_from_path(window.location.pathname)
  ));
  const player_ref = useRef<PlayerHandle>(null);
  const download_controller_ref = useRef<AbortController | null>(null);
  const analysis_controller_ref = useRef<AbortController | null>(null);

  const selected_asset = assets.find((asset) => asset.asset_id === selected_asset_id) ?? null;
  const { markers, marker_error, add_marker, update_marker_tags, remove_marker } = use_asset_markers(
    selected_asset?.asset_id ?? "",
  );

  useEffect(() => {
    const controller = new AbortController();
    void Promise.all([get_health(controller.signal), refresh_assets(controller.signal)])
      .then(([next_health]) => set_health(next_health))
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_page_error(error_message(error));
      });
    return () => controller.abort();
  }, []);

  useEffect(() => () => {
    download_controller_ref.current?.abort();
    analysis_controller_ref.current?.abort();
  }, []);

  useEffect(() => {
    const current_module = WORKSPACE_MODULES.find((module) => module.path === window.location.pathname);
    if (!current_module) window.history.replaceState(null, "", "/downloads");

    function sync_workspace_module() {
      set_active_workspace_module(workspace_module_id_from_path(window.location.pathname));
    }

    window.addEventListener("popstate", sync_workspace_module);
    return () => window.removeEventListener("popstate", sync_workspace_module);
  }, []);

  useEffect(() => {
    set_current_time(0);
  }, [selected_asset_id]);

  useEffect(() => {
    if (!selected_asset_id) {
      set_segments([]);
      set_transcript(null);
      return;
    }
    const controller = new AbortController();
    void load_asset_analysis(selected_asset_id, controller.signal)
      .then(({ loaded_segments, loaded_transcript }) => {
        set_segments(loaded_segments);
        set_transcript(loaded_transcript);
      })
      .catch((error: unknown) => {
        if (!is_abort_error(error)) set_page_error(error_message(error));
      });
    return () => controller.abort();
  }, [selected_asset_id]);

  async function refresh_assets(signal?: AbortSignal) {
    const next_assets = await list_assets(signal);
    set_assets(next_assets);
    set_selected_asset_id((current_id) => {
      if (current_id && next_assets.some((asset) => asset.asset_id === current_id)) return current_id;
      return next_assets.find((asset) => asset.status === "ready")?.asset_id ?? null;
    });
  }

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
      set_selected_probe_urls(new Set(probe.entries.map((entry) => entry.url)));
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_submitting(false);
    }
  }

  async function start_selected_downloads() {
    const urls = [...selected_probe_urls];
    if (urls.length === 0) {
      set_page_error("请至少选择一个视频");
      return;
    }
    set_is_submitting(true);
    set_page_error(null);
    try {
      await start_downloads(urls);
      set_probe_result(null);
      set_selected_probe_urls(new Set());
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_submitting(false);
    }
  }

  async function start_downloads(urls: string[]) {
    download_controller_ref.current?.abort();
    const controller = new AbortController();
    download_controller_ref.current = controller;
    const jobs = await create_download(urls, controller.signal);
    jobs.forEach(record_download_job);
    set_is_task_drawer_open(true);
    const final_jobs = await Promise.all(jobs.map((job) => (
      terminal_download_stages.has(job.stage)
        ? Promise.resolve(job)
        : poll_download(
          job,
          record_download_job,
          controller.signal,
        )
    )));
    final_jobs.forEach(record_download_job);
    const completed_jobs = final_jobs.filter((job) => job.stage === "complete");
    const failed_job = final_jobs.find((job) => job.stage === "failed");
    if (completed_jobs.length > 0) {
      await refresh_assets(controller.signal);
      set_selected_asset_id(completed_jobs[completed_jobs.length - 1].asset_id);
      set_source_url("");
    }
    if (failed_job) set_page_error(failed_job.error_message ?? "部分视频下载失败");
    if (download_controller_ref.current === controller) download_controller_ref.current = null;
  }

  async function start_analysis() {
    if (!selected_asset_id) return;
    analysis_controller_ref.current?.abort();
    const controller = new AbortController();
    analysis_controller_ref.current = controller;
    set_is_analyzing(true);
    set_page_error(null);
    set_is_task_drawer_open(true);
    try {
      const job = await analyze_asset(selected_asset_id, controller.signal);
      record_analysis_job(job);
      const final_job = job.stage === "complete" ? job : await poll_analysis(job, record_analysis_job, controller.signal);
      if (final_job.stage === "failed") {
        set_page_error(final_job.error_message ?? "分析失败");
        return;
      }
      const loaded_analysis = await load_asset_analysis(selected_asset_id, controller.signal);
      set_segments(loaded_analysis.loaded_segments);
      set_transcript(loaded_analysis.loaded_transcript);
    } catch (error: unknown) {
      if (!is_abort_error(error)) set_page_error(error_message(error));
    } finally {
      set_is_analyzing(false);
      if (analysis_controller_ref.current === controller) analysis_controller_ref.current = null;
    }
  }

  function add_marker_at_current_time() {
    const player_time = player_ref.current?.current_time() ?? current_time;
    const duration = selected_asset?.duration_seconds;
    const bounded_time = duration === null || duration === undefined
      ? Math.max(0, player_time)
      : Math.min(Math.max(0, player_time), duration);
    void add_marker(bounded_time);
  }

  function record_download_job(job: DownloadJob) {
    record_task({
      task_id: job.job_id,
      task_type: "download",
      stage: job.stage,
      message: job.message,
      progress_percent: job.progress_percent,
      error_message: job.error_message,
    });
  }

  function record_analysis_job(job: AnalysisJob) {
    record_task({
      task_id: job.job_id,
      task_type: "analysis",
      stage: job.stage,
      message: job.message,
      progress_percent: job.progress_percent,
      error_message: job.error_message,
    });
  }

  function record_task(task: TaskRecord) {
    set_task_records((current) => {
      const previous_task = current.find((item) => item.task_id === task.task_id);
      const remaining_tasks = current.filter((item) => item.task_id !== task.task_id);
      const next_tasks = previous_task ? [task, ...remaining_tasks] : [task, ...current];
      return next_tasks.slice(0, MAX_TASK_RECORDS);
    });
  }

  function navigate_to_workspace_module(module: WorkspaceModule) {
    if (window.location.pathname !== module.path) window.history.pushState(null, "", module.path);
    set_active_workspace_module(module.id);
  }

  return (
    <div className="workbench_shell">
      <header className="workbench_header">
        <div className="workbench_brand"><Clapperboard aria-hidden="true" /><strong>OpenVideo</strong></div>
        <nav className="workbench_navigation" aria-label="工作区导航">
          {WORKSPACE_MODULES.map((module) => (
            <WorkspaceNavigationLink
              key={module.id}
              module={module}
              active={active_workspace_module === module.id}
              on_navigate={navigate_to_workspace_module}
            />
          ))}
        </nav>
      </header>
      <main className={active_workspace_module === "analysis" ? "workbench_main" : "module_main"}>
        {active_workspace_module === "download" ? (
          <DownloadWorkspace
            health={health}
            task_records={task_records}
            source_url={source_url}
            probe_result={probe_result}
            selected_urls={selected_probe_urls}
            is_submitting={is_submitting}
            error={page_error}
            on_source_url_change={set_source_url}
            on_submit_probe={submit_source_probe}
            on_toggle_url={(url) => set_selected_probe_urls((current) => {
              const next = new Set(current);
              if (next.has(url)) next.delete(url);
              else next.add(url);
              return next;
            })}
            on_start_download={() => void start_selected_downloads()}
          />
        ) : null}
        {active_workspace_module === "analysis" ? (
          <>
            <AssetLibrary
              assets={assets}
              selected_asset_id={selected_asset_id}
              on_select={set_selected_asset_id}
            />
            <VideoWorkspace
              asset={selected_asset}
              markers={markers}
              current_time={current_time}
              player_ref={player_ref}
              on_time_change={set_current_time}
              on_add_marker={add_marker_at_current_time}
              is_analyzing={is_analyzing}
              on_start_analysis={() => void start_analysis()}
            />
            <Inspector
              asset_id={selected_asset?.asset_id ?? ""}
              transcript={transcript}
              segments={segments}
              markers={markers}
              marker_error={marker_error}
              on_seek={(seconds) => player_ref.current?.seek_to(seconds)}
              on_remove_marker={(marker_id) => void remove_marker(marker_id)}
              on_update_marker_tags={(marker_id, tags) => void update_marker_tags(marker_id, tags)}
            />
          </>
        ) : null}
        {active_workspace_module === "summary" ? (
          <SummaryWorkspace selected_asset={selected_asset} segments={segments} transcript={transcript} />
        ) : null}
      </main>
      {page_error && active_workspace_module !== "download" ? <p className="workbench_error" role="alert">{page_error}</p> : null}
      <TaskDrawer
        open={is_task_drawer_open}
        task_records={task_records}
        on_toggle={() => set_is_task_drawer_open((open) => !open)}
      />
    </div>
  );
}

type WorkspaceNavigationLinkProps = {
  module: WorkspaceModule;
  active: boolean;
  on_navigate: (module: WorkspaceModule) => void;
};

function WorkspaceNavigationLink({ module, active, on_navigate }: WorkspaceNavigationLinkProps) {
  const ModuleIcon = module.icon;
  return (
    <a
      href={module.path}
      className={active ? "active" : undefined}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault();
        on_navigate(module);
      }}
    >
      <ModuleIcon aria-hidden="true" />
      {module.label}
    </a>
  );
}

async function load_asset_analysis(asset_id: string, signal: AbortSignal) {
  const [loaded_segments, loaded_transcript] = await Promise.all([
    load_optional_segments(asset_id, signal),
    load_optional_transcript(asset_id, signal),
  ]);
  return { loaded_segments, loaded_transcript };
}

async function load_optional_segments(asset_id: string, signal: AbortSignal): Promise<MediaSegment[]> {
  try {
    return await get_segments(asset_id, signal);
  } catch (error) {
    if (is_not_found_error(error)) return [];
    throw error;
  }
}

async function load_optional_transcript(asset_id: string, signal: AbortSignal): Promise<Transcript | null> {
  try {
    return await get_transcript(asset_id, signal);
  } catch (error) {
    if (is_not_found_error(error)) return null;
    throw error;
  }
}

function error_message(error: unknown): string {
  if (is_abort_error(error)) return "请求已取消";
  if (is_api_error(error) || error instanceof Error) return error.message;
  return "发生了未知错误";
}

function is_api_error(error: unknown): error is ApiError {
  return error instanceof Error && "status" in error;
}

function is_not_found_error(error: unknown): error is ApiError {
  return is_api_error(error) && error.status === 404;
}

function is_abort_error(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}
