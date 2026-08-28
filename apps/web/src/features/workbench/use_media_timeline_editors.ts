import { type FormEvent, useEffect, useState } from "react";

import type {
  MediaMarker,
  MediaMarkerUpdate,
  Transcript,
} from "@/shared/types";
import { round_marker_time } from "./media_timeline_calculations";

export type TimelinePointerPosition = {
  x: number;
  y: number;
};

type MediaTimelineEditorOptions = {
  asset_id: string | null;
  markers: MediaMarker[];
  on_delete_marker: (marker_id: string) => Promise<void>;
  on_select_marker: (marker_id: string | null) => void;
  on_update_marker: (
    marker_id: string,
    update: MediaMarkerUpdate,
  ) => Promise<void>;
  on_update_transcript: (segment_index: number, text: string) => Promise<void>;
  transcript_segments: Transcript["segments"];
};

export function use_media_timeline_editors({
  asset_id,
  markers,
  on_delete_marker,
  on_select_marker,
  on_update_marker,
  on_update_transcript,
  transcript_segments,
}: MediaTimelineEditorOptions) {
  const [editing_transcript_index, set_editing_transcript_index] = useState<
    number | null
  >(null);
  const [transcript_draft, set_transcript_draft] = useState("");
  const [transcript_error, set_transcript_error] = useState<string | null>(
    null,
  );
  const [is_saving_transcript, set_is_saving_transcript] = useState(false);
  const [editing_marker_id, set_editing_marker_id] = useState<string | null>(
    null,
  );
  const [marker_start_draft, set_marker_start_draft] = useState(0);
  const [marker_end_draft, set_marker_end_draft] = useState<number | null>(
    null,
  );
  const [marker_save_error, set_marker_save_error] = useState<string | null>(
    null,
  );
  const [is_saving_marker, set_is_saving_marker] = useState(false);
  const [marker_editor_position, set_marker_editor_position] =
    useState<TimelinePointerPosition | null>(null);

  useEffect(() => {
    set_editing_marker_id(null);
    set_marker_start_draft(0);
    set_marker_end_draft(null);
    set_marker_save_error(null);
    set_marker_editor_position(null);
    set_editing_transcript_index(null);
    set_transcript_draft("");
    set_transcript_error(null);
  }, [asset_id]);

  function cancel_transcript_edit() {
    set_editing_transcript_index(null);
    set_transcript_draft("");
    set_transcript_error(null);
  }

  function cancel_marker_edit() {
    set_editing_marker_id(null);
    set_marker_start_draft(0);
    set_marker_end_draft(null);
    set_marker_save_error(null);
    set_marker_editor_position(null);
  }

  function edit_marker(
    marker_id: string,
    pointer_position: TimelinePointerPosition,
  ) {
    const marker = markers.find(
      (candidate) => candidate.marker_id === marker_id,
    );
    if (!marker) return;
    on_select_marker(marker.marker_id);
    set_editing_marker_id(marker.marker_id);
    set_marker_start_draft(marker.start_seconds);
    set_marker_end_draft(marker.end_seconds);
    set_marker_save_error(null);
    set_marker_editor_position(pointer_position);
    cancel_transcript_edit();
  }

  function edit_transcript(segment_index: number) {
    const segment = transcript_segments[segment_index];
    if (!segment) return;
    cancel_marker_edit();
    set_editing_transcript_index(segment_index);
    set_transcript_draft(segment.text);
    set_transcript_error(null);
  }

  async function save_transcript(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing_transcript_index === null) return;
    const text = transcript_draft.trim();
    if (!text) return;
    set_is_saving_transcript(true);
    set_transcript_error(null);
    try {
      await on_update_transcript(editing_transcript_index, text);
      cancel_transcript_edit();
    } catch {
      set_transcript_error("转写保存失败，请稍后重试");
    } finally {
      set_is_saving_transcript(false);
    }
  }

  function save_marker(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (editing_marker_id === null) return;
    set_is_saving_marker(true);
    set_marker_save_error(null);
    void on_update_marker(editing_marker_id, {
      start_seconds: round_marker_time(marker_start_draft),
      end_seconds:
        marker_end_draft === null ? null : round_marker_time(marker_end_draft),
    })
      .then(cancel_marker_edit)
      .catch(() => set_marker_save_error("标记保存失败，请稍后重试"))
      .finally(() => set_is_saving_marker(false));
  }

  function delete_marker() {
    if (editing_marker_id === null) return;
    set_is_saving_marker(true);
    set_marker_save_error(null);
    void on_delete_marker(editing_marker_id)
      .then(() => {
        on_select_marker(null);
        cancel_marker_edit();
      })
      .catch(() => set_marker_save_error("标记删除失败，请稍后重试"))
      .finally(() => set_is_saving_marker(false));
  }

  return {
    cancel_marker_edit,
    cancel_transcript_edit,
    delete_marker,
    edit_marker,
    edit_transcript,
    editing_marker_id,
    editing_transcript_index,
    is_saving_marker,
    is_saving_transcript,
    marker_editor_position,
    marker_end_draft,
    marker_save_error,
    marker_start_draft,
    save_marker,
    save_transcript,
    set_marker_end_draft,
    set_marker_start_draft,
    set_transcript_draft,
    transcript_draft,
    transcript_error,
  };
}
