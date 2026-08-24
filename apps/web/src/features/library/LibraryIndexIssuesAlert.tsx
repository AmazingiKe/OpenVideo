import { TriangleAlert } from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import type { LibraryIndexIssue } from "@/shared/types";

type LibraryIndexIssuesAlertProps = {
  issues: LibraryIndexIssue[];
};

export function LibraryIndexIssuesAlert({
  issues,
}: LibraryIndexIssuesAlertProps) {
  if (issues.length === 0) return null;

  return (
    <Alert role="status" aria-live="polite">
      <TriangleAlert aria-hidden="true" />
      <AlertTitle>部分素材暂时无法建立索引</AlertTitle>
      <AlertDescription>
        <p>
          其他素材仍可正常使用。修复以下业务文件后，重新打开资料库即可恢复。
        </p>
        <ul className="mt-2 grid gap-1">
          {issues.map((issue) => (
            <li key={`${issue.relative_path}:${issue.code}`}>
              <code className="font-mono text-xs break-all text-foreground">
                {issue.relative_path}
              </code>
              <span>：{issue.message}</span>
            </li>
          ))}
        </ul>
      </AlertDescription>
    </Alert>
  );
}
