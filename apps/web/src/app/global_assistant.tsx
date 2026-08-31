import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useLocation } from "react-router-dom";

import { use_asset_catalog } from "@/app/asset_catalog";
import { use_local_preferences } from "@/app/local_preferences";
import { workspace_route } from "@/app/workspace_routes";
import { AgentPanel } from "@/components/AgentPanel";
import type { AgentContextAttachmentDraft } from "@/components/agent_context";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import {
  use_agent_preferences,
  use_ai_models,
} from "@/features/workbench/use_processing_resources";
import type {
  AgentArtifact,
  AgentEvidenceReference,
  AgentFocusContext,
} from "@/shared/types";

const COMPACT_ASSISTANT_QUERY = "(max-width: 1199px)";
const DEFAULT_PANEL_SIZE_PERCENT = 30;
const ASSISTANT_PANEL_MIN_WIDTH_PX = 352;
const ASSISTANT_PANEL_MAX_WIDTH_PX = 576;
const WORKSPACE_PANEL_MIN_WIDTH_PX = 480;
const ASSISTANT_PANEL_ID = "global-assistant-panel";

export type GlobalAssistantBinding = {
  agent_id: string;
  asset_id: string | null;
  context_label: string;
  context?: Record<string, unknown>;
  focus_context?: AgentFocusContext;
  task_input?: Record<string, unknown>;
  context_attachments?: AgentContextAttachmentDraft[];
  placeholder?: string;
  panel_size_percent?: number;
  on_panel_size_percent_change?: (size_percent: number) => void;
  on_seek?: (
    seconds: number,
    end_seconds?: number | null,
    evidence?: AgentEvidenceReference,
  ) => void;
  current_time?: number;
  on_artifact_change?: (artifact: AgentArtifact) => void | Promise<void>;
};

type RegisteredBinding = {
  registration_id: symbol;
  binding: GlobalAssistantBinding;
};

type GlobalAssistantControls = {
  open: boolean;
  set_open: (open: boolean) => void;
};

type GlobalAssistantRegistry = {
  register: (
    workspace_path: string,
    binding: GlobalAssistantBinding,
  ) => () => void;
};

type GlobalAssistantLayoutState = GlobalAssistantControls & {
  binding_for: (workspace_path: string) => GlobalAssistantBinding | null;
};

const GlobalAssistantControlsContext =
  createContext<GlobalAssistantControls | null>(null);
const GlobalAssistantRegistryContext =
  createContext<GlobalAssistantRegistry | null>(null);
const GlobalAssistantLayoutContext =
  createContext<GlobalAssistantLayoutState | null>(null);

export function GlobalAssistantProvider({ children }: { children: ReactNode }) {
  const { preferences, set_assistant_open } = use_local_preferences();
  const open = preferences.assistant_open ?? !compact_assistant_layout();
  const [bindings, set_bindings] = useState(
    () => new Map<string, RegisteredBinding>(),
  );
  const register = useCallback(
    (workspace_path: string, binding: GlobalAssistantBinding) => {
      const registration_id = Symbol(workspace_path);
      set_bindings((current) => {
        const next = new Map(current);
        next.set(workspace_path, { registration_id, binding });
        return next;
      });
      return () => {
        set_bindings((current) => {
          if (
            current.get(workspace_path)?.registration_id !== registration_id
          ) {
            return current;
          }
          const next = new Map(current);
          next.delete(workspace_path);
          return next;
        });
      };
    },
    [],
  );
  const binding_for = useCallback(
    (workspace_path: string) => bindings.get(workspace_path)?.binding ?? null,
    [bindings],
  );
  const controls = useMemo(
    () => ({ open, set_open: set_assistant_open }),
    [open, set_assistant_open],
  );
  const registry = useMemo(() => ({ register }), [register]);
  const layout = useMemo(
    () => ({ open, set_open: set_assistant_open, binding_for }),
    [binding_for, open, set_assistant_open],
  );

  return (
    <GlobalAssistantControlsContext.Provider value={controls}>
      <GlobalAssistantRegistryContext.Provider value={registry}>
        <GlobalAssistantLayoutContext.Provider value={layout}>
          {children}
        </GlobalAssistantLayoutContext.Provider>
      </GlobalAssistantRegistryContext.Provider>
    </GlobalAssistantControlsContext.Provider>
  );
}

export function GlobalAssistantRegistration({
  binding,
}: {
  binding: GlobalAssistantBinding;
}) {
  const location = useLocation();
  const { register } = require_global_assistant_registry();
  const workspace_path =
    workspace_route(location.pathname)?.path ?? location.pathname;

  useEffect(
    () => register(workspace_path, binding),
    [binding, register, workspace_path],
  );
  return null;
}

export function use_global_assistant_controls() {
  const assistant = require_global_assistant_controls();
  return {
    assistant_open: assistant.open,
    open_assistant: () => assistant.set_open(true),
    set_assistant_open: assistant.set_open,
  };
}

export function GlobalAssistantLayout({ children }: { children: ReactNode }) {
  const location = useLocation();
  const assistant = require_global_assistant_layout();
  const { selected_asset, selected_asset_id } = use_asset_catalog();
  const { models } = use_ai_models();
  const {
    agent_preferences,
    error: agent_preferences_error,
    permission_mode_saving,
    set_permission_mode,
  } = use_agent_preferences();
  const compact = use_compact_assistant_layout();
  const workspace_path =
    workspace_route(location.pathname)?.path ?? location.pathname;
  const registered_binding = assistant.binding_for(workspace_path);
  const binding = registered_binding ?? {
    agent_id: "marker",
    asset_id: selected_asset_id,
    context_label: selected_asset
      ? `当前视频 · ${selected_asset.title}`
      : "尚未选择视频",
    placeholder: "询问当前视频；需要时可明确切换到资料库范围…",
  };
  const panel_size_percent =
    binding.panel_size_percent ?? DEFAULT_PANEL_SIZE_PERCENT;
  const docked = assistant.open && !compact;
  const assistant_panel = (
    <AgentPanel
      className="h-full rounded-none border-0"
      agent_id={binding.agent_id}
      asset_id={binding.asset_id}
      models={models}
      context={binding.context}
      focus_context={binding.focus_context}
      task_input={binding.task_input}
      context_attachments={binding.context_attachments}
      default_thinking_mode={agent_preferences?.default_thinking_mode}
      thinking_modes_enabled
      library_scope_enabled
      permission_mode={agent_preferences?.permission_mode}
      on_permission_mode_change={
        agent_preferences ? set_permission_mode : undefined
      }
      permission_mode_saving={permission_mode_saving}
      permission_mode_error={agent_preferences_error}
      title="OpenVideo 助手"
      context_label={binding.context_label}
      placeholder={binding.placeholder}
      on_seek={binding.on_seek}
      current_time={binding.current_time}
      on_artifact_change={binding.on_artifact_change}
    />
  );

  return (
    <div
      className="min-h-0 flex-1 overflow-hidden"
      data-slot="global-assistant-layout"
    >
      {docked ? (
        <ResizablePanelGroup
          orientation="horizontal"
          onLayoutChanged={(layout, metadata) => {
            const next_size = layout[ASSISTANT_PANEL_ID];
            if (metadata.isUserInteraction && next_size !== undefined) {
              binding.on_panel_size_percent_change?.(next_size);
            }
          }}
        >
          <ResizablePanel
            id="global-assistant-workspace"
            minSize={`${WORKSPACE_PANEL_MIN_WIDTH_PX}px`}
          >
            <div className="h-full min-h-0 min-w-0 overflow-hidden">
              {children}
            </div>
          </ResizablePanel>
          <ResizableHandle withHandle aria-label="调整助手宽度" />
          <ResizablePanel
            id={ASSISTANT_PANEL_ID}
            defaultSize={`${panel_size_percent}%`}
            minSize={`${ASSISTANT_PANEL_MIN_WIDTH_PX}px`}
            maxSize={`${ASSISTANT_PANEL_MAX_WIDTH_PX}px`}
            groupResizeBehavior="preserve-pixel-size"
          >
            <aside className="h-full min-h-0 bg-card" aria-label="全局助手">
              {assistant_panel}
            </aside>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="h-full min-h-0 min-w-0 overflow-hidden">{children}</div>
      )}
      {compact ? (
        <Sheet open={assistant.open} onOpenChange={assistant.set_open}>
          <SheetContent side="right" className="w-[min(92vw,28rem)] gap-0 p-0">
            <SheetHeader className="sr-only">
              <SheetTitle>OpenVideo 助手</SheetTitle>
              <SheetDescription>
                对话会绑定当前视频、文档或任务，修改在确认后应用。
              </SheetDescription>
            </SheetHeader>
            {assistant_panel}
          </SheetContent>
        </Sheet>
      ) : null}
    </div>
  );
}

function use_compact_assistant_layout(): boolean {
  const [compact, set_compact] = useState(compact_assistant_layout);

  useEffect(() => {
    if (!window.matchMedia) return;
    const query = window.matchMedia(COMPACT_ASSISTANT_QUERY);
    const update = () => set_compact(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return compact;
}

function compact_assistant_layout(): boolean {
  return (
    typeof window !== "undefined" &&
    (window.matchMedia?.(COMPACT_ASSISTANT_QUERY).matches ?? false)
  );
}

function require_global_assistant_controls(): GlobalAssistantControls {
  const assistant = useContext(GlobalAssistantControlsContext);
  if (!assistant) {
    throw new Error("全局助手控制器必须在 GlobalAssistantProvider 内使用");
  }
  return assistant;
}

function require_global_assistant_registry(): GlobalAssistantRegistry {
  const assistant = useContext(GlobalAssistantRegistryContext);
  if (!assistant) {
    throw new Error("全局助手绑定必须在 GlobalAssistantProvider 内使用");
  }
  return assistant;
}

function require_global_assistant_layout(): GlobalAssistantLayoutState {
  const assistant = useContext(GlobalAssistantLayoutContext);
  if (!assistant) {
    throw new Error("全局助手布局必须在 GlobalAssistantProvider 内使用");
  }
  return assistant;
}
