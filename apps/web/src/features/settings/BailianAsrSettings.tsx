import { useState } from "react";
import { Cloud, TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { error_message } from "@/shared/errors";
import type {
  BailianAsrRegion,
  BailianAsrConfiguration,
  BailianAsrSettingsUpdate,
  BailianAsrTestResult,
} from "@/shared/types";

type BailianAsrSettingsProps = {
  value: BailianAsrConfiguration;
  on_save: (
    update: BailianAsrSettingsUpdate,
  ) => Promise<BailianAsrConfiguration>;
  on_test: () => Promise<BailianAsrTestResult>;
};

export function BailianAsrSettings({
  value,
  on_save,
  on_test,
}: BailianAsrSettingsProps) {
  const [region, set_region] = useState(value.region);
  const [api_key, set_api_key] = useState("");
  const [pending, set_pending] = useState<"save" | "test" | null>(null);
  const [feedback, set_feedback] = useState<{
    message: string;
    error: boolean;
  } | null>(null);
  const has_changes = region !== value.region || api_key.trim().length > 0;

  async function save_configuration(update: BailianAsrSettingsUpdate) {
    set_pending("save");
    set_feedback(null);
    try {
      const saved = await on_save(update);
      set_region(saved.region);
      set_api_key("");
      set_feedback({ message: "百炼语音配置已保存。", error: false });
    } catch (error) {
      set_feedback({ message: error_message(error), error: true });
    } finally {
      set_pending(null);
    }
  }

  async function test_connection() {
    set_pending("test");
    set_feedback(null);
    try {
      const result = await on_test();
      set_feedback({ message: result.message, error: !result.configured });
    } catch (error) {
      set_feedback({ message: error_message(error), error: true });
    } finally {
      set_pending(null);
    }
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        void save_configuration({
          region,
          ...(api_key.trim() ? { api_key: api_key.trim() } : {}),
        });
      }}
    >
      <Alert>
        <Cloud aria-hidden="true" />
        <AlertTitle className="flex flex-wrap items-center gap-2">
          云端语音识别
          <Badge variant={value.api_key_configured ? "secondary" : "outline"}>
            {value.api_key_configured ? "密钥已配置" : "尚未配置密钥"}
          </Badge>
        </AlertTitle>
        <AlertDescription>
          支持 Fun-ASR 和
          Paraformer，无需下载模型。转写会将音频上传至所选区域的阿里云百炼，并按音频时长计费。
        </AlertDescription>
      </Alert>
      <FieldGroup>
        <div className="grid gap-6 md:grid-cols-2">
          <Field data-disabled={pending !== null || undefined}>
            <FieldLabel htmlFor="bailian_asr_region">服务区域</FieldLabel>
            <Select
              value={region}
              onValueChange={(next_region) =>
                set_region(next_region as BailianAsrRegion)
              }
              disabled={pending !== null}
            >
              <SelectTrigger id="bailian_asr_region" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="beijing">华北 2（北京）</SelectItem>
                  <SelectItem value="singapore">新加坡</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
            <FieldDescription>
              密钥须与服务区域一致。新加坡仅支持 Fun-ASR；默认使用 Paraformer
              时，请先切换默认模型。
            </FieldDescription>
          </Field>
          <Field data-disabled={pending !== null || undefined}>
            <FieldLabel htmlFor="bailian_asr_api_key">百炼 API Key</FieldLabel>
            <Input
              id="bailian_asr_api_key"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              value={api_key}
              placeholder={
                value.api_key_configured
                  ? "留空保留已保存密钥"
                  : "输入百炼 API Key"
              }
              onChange={(event) => set_api_key(event.target.value)}
              disabled={pending !== null}
            />
            <FieldDescription>
              密钥保存在本机系统凭据存储，不会回显。输入后需点击保存。
            </FieldDescription>
          </Field>
        </div>
      </FieldGroup>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={pending !== null || !has_changes}>
          {pending === "save" ? <Spinner data-icon="inline-start" /> : null}
          保存百炼配置
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={
            pending !== null || has_changes || !value.api_key_configured
          }
          onClick={() => void test_connection()}
        >
          {pending === "test" ? <Spinner data-icon="inline-start" /> : null}
          测试连接
        </Button>
        {value.api_key_configured ? (
          <Button
            type="button"
            variant="ghost"
            disabled={pending !== null || has_changes}
            onClick={() => void save_configuration({ api_key: "" })}
          >
            移除密钥
          </Button>
        ) : null}
      </div>
      <FieldDescription>
        测试连接使用已保存配置，仅检查鉴权与上传凭证，不提交转写任务。其他设置仍自动保存。
      </FieldDescription>
      {feedback ? (
        <Alert
          variant={feedback.error ? "destructive" : "default"}
          role="status"
        >
          {feedback.error ? (
            <TriangleAlert aria-hidden="true" />
          ) : (
            <Cloud aria-hidden="true" />
          )}
          <AlertTitle>
            {feedback.error ? "百炼配置未就绪" : "百炼语音服务"}
          </AlertTitle>
          <AlertDescription>{feedback.message}</AlertDescription>
        </Alert>
      ) : null}
    </form>
  );
}
