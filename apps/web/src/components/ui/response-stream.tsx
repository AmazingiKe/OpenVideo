"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

const DEFAULT_STREAM_SPEED = 80;
const MINIMUM_STREAM_SPEED = 1;
const MAXIMUM_STREAM_SPEED = 100;

export type ResponseStreamProps = {
  text_stream: string;
  stream_live?: boolean;
  speed?: number;
  className?: string;
  on_complete?: () => void;
};

/**
 * prompt-kit ResponseStream 的增量文本版本。
 *
 * SSE 会持续扩展同一个字符串，因此这里保留已经显示的内容，只消费新增字符；
 * prompt-kit 原版面向固定字符串，每次属性变化都会从头播放，不适合真实流输出。
 */
export function ResponseStream({
  text_stream,
  stream_live = true,
  speed = DEFAULT_STREAM_SPEED,
  className,
  on_complete,
}: ResponseStreamProps) {
  const [displayed_text, set_displayed_text] = useState("");
  const displayed_text_ref = useRef("");
  const target_segments_ref = useRef<string[]>([]);
  const segment_index_ref = useRef(0);
  const animation_frame_ref = useRef<number | null>(null);
  const last_frame_time_ref = useRef(0);
  const completion_reported_ref = useRef(false);
  const stream_live_ref = useRef(stream_live);
  const on_complete_ref = useRef(on_complete);

  useEffect(() => {
    stream_live_ref.current = stream_live;
    on_complete_ref.current = on_complete;
  }, [on_complete, stream_live]);

  const finish_if_ready = useCallback(() => {
    if (
      stream_live_ref.current ||
      completion_reported_ref.current ||
      segment_index_ref.current < target_segments_ref.current.length
    ) {
      return;
    }
    completion_reported_ref.current = true;
    on_complete_ref.current?.();
  }, []);

  useEffect(() => {
    function stream_next_character(timestamp: number) {
      const normalized_speed = Math.min(
        MAXIMUM_STREAM_SPEED,
        Math.max(MINIMUM_STREAM_SPEED, speed),
      );
      const frame_delay = Math.max(
        1,
        Math.round(100 / Math.sqrt(normalized_speed)),
      );
      if (timestamp - last_frame_time_ref.current < frame_delay) {
        animation_frame_ref.current = requestAnimationFrame(
          stream_next_character,
        );
        return;
      }
      last_frame_time_ref.current = timestamp;

      const next_segment =
        target_segments_ref.current[segment_index_ref.current];
      if (next_segment === undefined) {
        animation_frame_ref.current = null;
        finish_if_ready();
        return;
      }

      segment_index_ref.current += 1;
      displayed_text_ref.current += next_segment;
      set_displayed_text(displayed_text_ref.current);

      if (segment_index_ref.current < target_segments_ref.current.length) {
        animation_frame_ref.current = requestAnimationFrame(
          stream_next_character,
        );
      } else {
        animation_frame_ref.current = null;
        finish_if_ready();
      }
    }

    const current_text = displayed_text_ref.current;
    if (!text_stream.startsWith(current_text)) {
      displayed_text_ref.current = "";
      segment_index_ref.current = 0;
      completion_reported_ref.current = false;
      set_displayed_text("");
    }

    target_segments_ref.current = segment_text(text_stream);
    if (segment_index_ref.current < target_segments_ref.current.length) {
      completion_reported_ref.current = false;
      if (animation_frame_ref.current === null) {
        animation_frame_ref.current = requestAnimationFrame(
          stream_next_character,
        );
      }
    } else {
      finish_if_ready();
    }

    return () => {
      if (animation_frame_ref.current !== null) {
        cancelAnimationFrame(animation_frame_ref.current);
        animation_frame_ref.current = null;
      }
    };
  }, [finish_if_ready, speed, stream_live, text_stream]);

  return (
    <>
      <span
        data-slot="response-stream"
        className={cn("whitespace-pre-wrap", className)}
        aria-hidden="true"
      >
        {displayed_text}
      </span>
      <span className="sr-only">
        {stream_live ? "正在生成回答" : "回答已生成，正在完成显示"}
      </span>
    </>
  );
}

function segment_text(text: string): string[] {
  if (typeof Intl.Segmenter === "function") {
    return Array.from(
      new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(text),
      (segment) => segment.segment,
    );
  }
  return Array.from(text);
}
