import { History, Play, RotateCcw } from "lucide-react";
import { useId } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { format_duration, format_time } from "@/shared/format";
import type { MediaAsset } from "@/shared/types";

type RecentVideosProps = {
  assets: MediaAsset[];
  loading?: boolean;
  error?: string | null;
  on_retry: () => void;
  on_open: (asset: MediaAsset) => void;
};

const RECENT_VIDEO_PLACEHOLDER_COUNT = 3;
const PERCENTAGE_SCALE = 100;

export function RecentVideos({
  assets,
  loading = false,
  error,
  on_retry,
  on_open,
}: RecentVideosProps) {
  const heading_id = useId();

  return (
    <section
      className="flex min-w-0 flex-col gap-4"
      aria-labelledby={heading_id}
    >
      <div className="flex items-center gap-2">
        <History className="size-4 text-muted-foreground" aria-hidden="true" />
        <h2 id={heading_id} className="text-base font-medium">
          最近观看
        </h2>
        <p className="text-sm text-muted-foreground">接着上次的位置继续</p>
      </div>
      {error ? (
        <Alert variant="destructive">
          <AlertTitle>无法读取观看记录</AlertTitle>
          <AlertDescription>
            <p>{error}</p>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={on_retry}
            >
              重试
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {loading ? (
        <div
          role="status"
          aria-label="正在读取观看记录"
          className="grid gap-4 md:grid-cols-3"
        >
          {Array.from(
            { length: RECENT_VIDEO_PLACEHOLDER_COUNT },
            (_, index) => (
              <Skeleton key={index} className="h-40 rounded-xl" />
            ),
          )}
        </div>
      ) : assets.length ? (
        <ul className="grid gap-4 md:grid-cols-3">
          {assets.map((asset) => {
            const position = asset.playback?.position_seconds ?? 0;
            const rate = asset.playback?.playback_rate ?? 1;
            const duration = asset.duration_seconds;
            const has_duration = duration !== null && duration > 0;
            const completed = has_duration && position >= duration;
            const action = completed ? "重新观看" : "继续观看";
            return (
              <li key={asset.asset_id} className="min-w-0">
                <Card className="h-full">
                  <CardHeader>
                    <CardTitle>
                      <h3 className="line-clamp-2 break-words">
                        {asset.title}
                      </h3>
                    </CardTitle>
                    <CardDescription className="truncate">
                      {asset.author_name ?? "未知作者"}
                    </CardDescription>
                  </CardHeader>
                  <CardContent className="mt-auto flex flex-col gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground">
                      <span>
                        {completed ? "已看完" : `已看 ${format_time(position)}`}
                      </span>
                      <span className="tabular-nums">
                        {has_duration ? format_duration(duration) : "时长未知"}{" "}
                        · {rate} 倍速
                      </span>
                    </div>
                    {has_duration ? (
                      <Progress
                        value={Math.min(
                          PERCENTAGE_SCALE,
                          (position / duration) * PERCENTAGE_SCALE,
                        )}
                        aria-label={`${asset.title}观看进度`}
                      />
                    ) : null}
                  </CardContent>
                  <CardFooter>
                    <Button
                      type="button"
                      variant="secondary"
                      className="w-full"
                      aria-label={`${action}：${asset.title}`}
                      onClick={() => on_open(asset)}
                    >
                      {completed ? (
                        <RotateCcw
                          data-icon="inline-start"
                          aria-hidden="true"
                        />
                      ) : (
                        <Play data-icon="inline-start" aria-hidden="true" />
                      )}
                      {action}
                    </Button>
                  </CardFooter>
                </Card>
              </li>
            );
          })}
        </ul>
      ) : !error ? (
        <Empty className="border py-4">
          <EmptyHeader>
            <EmptyTitle>尚无观看记录</EmptyTitle>
            <EmptyDescription>
              播放视频后会自动保存位置和倍速。
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : null}
    </section>
  );
}
