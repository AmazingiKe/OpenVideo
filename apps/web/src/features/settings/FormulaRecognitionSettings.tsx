import { Sigma } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  download_formula_model,
  get_formula_model_download,
} from "@/shared/api";
import type { FormulaModelState } from "@/shared/types";
import { ModelDownloadAction } from "./ModelDownloadAction";

const INSTALLATION_LABELS: Record<
  FormulaModelState["installation_status"],
  string
> = {
  not_installed: "未安装",
  downloading: "下载中",
  installed: "已安装",
  failed: "下载失败",
};

type FormulaRecognitionSettingsProps = {
  model: FormulaModelState;
  on_change: (model: FormulaModelState) => void;
};

export function FormulaRecognitionSettings({
  model,
  on_change,
}: FormulaRecognitionSettingsProps) {
  return (
    <Alert>
      <Sigma aria-hidden="true" />
      <AlertTitle className="flex flex-wrap items-center gap-2">
        {model.name}
        <Badge
          variant={
            model.installation_status === "installed" ? "secondary" : "outline"
          }
        >
          {INSTALLATION_LABELS[model.installation_status]}
        </Badge>
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-4">
        <p>
          {model.description}
          安装后自动参与关键帧分析，无需额外开关；识别失败时仍会保留普通画面文字。模型文件约
          394 MB。
        </p>
        <p className="text-xs text-muted-foreground">
          自动测速并选择国内 ModelScope 或海外 Hugging Face
          官方源，连接中断时切换备用源并续传。
        </p>
        <ul className="flex flex-col gap-2 text-xs text-muted-foreground">
          {model.repositories.map((repository) => (
            <li key={repository} className="truncate font-mono">
              {repository}
            </li>
          ))}
        </ul>
        <div className="max-w-48">
          <ModelDownloadAction
            name={model.name}
            installation_status={model.installation_status}
            job={model.download_job}
            start_download={download_formula_model}
            poll_download={get_formula_model_download}
            on_change={(installation_status, download_job) =>
              on_change({ ...model, installation_status, download_job })
            }
            action_label="下载公式模型"
          />
        </div>
      </AlertDescription>
    </Alert>
  );
}
