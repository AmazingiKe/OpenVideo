import {
  Activity,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import {
  BackendConnectionScreen,
  type BackendConnectionState,
} from "@/app/BackendConnectionScreen";
import { probe_backend } from "@/shared/api";
import { is_abort_error } from "@/shared/errors";

const BACKEND_PROBE_INTERVAL_MS = 3_000;

export function BackendConnectionGate({ children }: { children: ReactNode }) {
  const [connection_state, set_connection_state] = useState<
    BackendConnectionState | "connected"
  >("checking");
  const active_probe_ref = useRef<AbortController | null>(null);

  const probe = useCallback(async () => {
    active_probe_ref.current?.abort();
    const controller = new AbortController();
    active_probe_ref.current = controller;
    try {
      await probe_backend(controller.signal);
      set_connection_state("connected");
    } catch (error) {
      if (!is_abort_error(error)) set_connection_state("disconnected");
    } finally {
      if (active_probe_ref.current === controller) {
        active_probe_ref.current = null;
      }
    }
  }, []);

  useEffect(() => {
    void probe();
    const interval_id = window.setInterval(
      () => void probe(),
      BACKEND_PROBE_INTERVAL_MS,
    );
    const probe_immediately = () => void probe();
    window.addEventListener("focus", probe_immediately);
    window.addEventListener("online", probe_immediately);
    return () => {
      active_probe_ref.current?.abort();
      active_probe_ref.current = null;
      window.clearInterval(interval_id);
      window.removeEventListener("focus", probe_immediately);
      window.removeEventListener("online", probe_immediately);
    };
  }, [probe]);

  const connected = connection_state === "connected";
  return (
    <>
      <Activity mode={connected ? "visible" : "hidden"}>{children}</Activity>
      {!connected ? <BackendConnectionScreen state={connection_state} /> : null}
    </>
  );
}
