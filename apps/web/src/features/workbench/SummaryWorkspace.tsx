import { FileText, Layers3, MessageSquareText } from "lucide-react";

import type { MediaAsset, MediaSegment, Transcript } from "../../shared/types";
import { format_duration } from "../../shared/format";


type SummaryWorkspaceProps = {
  selected_asset: MediaAsset | null;
  segments: MediaSegment[];
  transcript: Transcript | null;
};

export function SummaryWorkspace({ selected_asset, segments, transcript }: SummaryWorkspaceProps) {
  return (
    <section className="module_workspace" aria-label="分析总结">
      <header className="module_heading">
        <div>
          <p>分析总结</p>
          <h1>汇总视频分析结果</h1>
          <span>在这里查看当前视频的转写、重点片段与后续生成的内容总结。</span>
        </div>
      </header>
      <div className="module_grid summary_grid">
        <section className="module_card summary_asset_card">
          <FileText aria-hidden="true" />
          <h2>当前素材</h2>
          {selected_asset ? (
            <>
              <strong>{selected_asset.title}</strong>
              <span>{selected_asset.author_name ?? "未知作者"} · {format_duration(selected_asset.duration_seconds)}</span>
            </>
          ) : <p className="module_empty_state">请先在视频分析页面选择已完成下载的视频。</p>}
        </section>
        <section className="module_card summary_metric_card">
          <header><div><MessageSquareText aria-hidden="true" /><h2>转写内容</h2></div></header>
          <strong>{transcript?.segments.length ?? 0}</strong>
          <span>个带时间戳的转写片段</span>
        </section>
        <section className="module_card summary_metric_card">
          <header><div><Layers3 aria-hidden="true" /><h2>重点片段</h2></div></header>
          <strong>{segments.length}</strong>
          <span>个可回跳的重点内容</span>
        </section>
        <section className="module_card summary_preview_card">
          <h2>总结预览</h2>
          <p>完成分析后，此区域将展示可编辑的视频摘要、关键观点与片段索引。</p>
        </section>
      </div>
    </section>
  );
}
