import { type FormEvent, useState } from "react";
import {
  CheckCircle2,
  CircleDashed,
  ExternalLink,
  LogIn,
  LogOut,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  UserRoundCheck,
} from "lucide-react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Spinner } from "@/components/ui/spinner";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import type { DownloadAccount, DownloadCookieBrowser } from "@/shared/types";

const DOUYIN_LOGIN_URL = "https://www.douyin.com/";

type DouyinAccountCardProps = {
  account: DownloadAccount | null;
  is_loading: boolean;
  error: string | null;
  on_save: (cookie: string) => Promise<void>;
  on_import_browser: (browser: DownloadCookieBrowser) => Promise<void>;
  on_test: () => Promise<void>;
  on_disconnect: () => Promise<void>;
};

export function DouyinAccountCard({
  account,
  is_loading,
  error,
  on_save,
  on_import_browser,
  on_test,
  on_disconnect,
}: DouyinAccountCardProps) {
  const [dialog_open, set_dialog_open] = useState(false);
  const [cookie, set_cookie] = useState("");
  const [browser, set_browser] = useState<DownloadCookieBrowser>("edge");

  async function submit_cookie(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    try {
      await on_save(cookie);
      set_cookie("");
      set_dialog_open(false);
    } catch {
      // 父级统一呈现 API 错误，保留输入便于用户修正后重试。
    }
  }

  async function import_from_browser() {
    try {
      await on_import_browser(browser);
      set_dialog_open(false);
    } catch {
      // 父级统一呈现 API 错误，保留对话框以便切换浏览器重试。
    }
  }

  const account_expired = account?.status === "expired";
  const status = account_status(account, is_loading);
  const StatusIcon = status.icon;

  return (
    <>
      <Card>
        <CardHeader className="border-b">
          <div className="flex items-center gap-3">
            <div className="flex size-9 items-center justify-center rounded-lg bg-primary/10 text-primary">
              <UserRoundCheck aria-hidden="true" />
            </div>
            <div>
              <CardTitle role="heading" aria-level={2}>
                抖音账号
              </CardTitle>
              <CardDescription>
                保存登录状态后，检测和下载会自动使用账号 Cookie。
              </CardDescription>
            </div>
          </div>
          <CardAction>
            <Badge variant={status.variant}>
              <StatusIcon data-icon="inline-start" />
              {status.label}
            </Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
          <div className="flex min-w-0 flex-col gap-1">
            <p className="font-medium">
              {account?.display_name ?? "尚未连接抖音账号"}
            </p>
            <p className="text-sm text-muted-foreground">
              {account
                ? account.last_tested_at
                  ? `上次测试：${format_account_time(account.last_tested_at)}`
                  : "Cookie 已保存，建议先测试可用性。"
                : "登录抖音网页版后，粘贴请求中的完整 Cookie。"}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {account ? (
              <Button
                type="button"
                variant="outline"
                onClick={() => void on_test()}
                disabled={is_loading || account_expired}
              >
                {is_loading ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <RefreshCw data-icon="inline-start" />
                )}
                测试账号
              </Button>
            ) : null}
            <Button
              type="button"
              onClick={() => set_dialog_open(true)}
              disabled={is_loading}
            >
              <LogIn data-icon="inline-start" />
              {account ? "重新登录" : "连接账号"}
            </Button>
          </div>
        </CardContent>
        {account_expired || error ? (
          <CardFooter>
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>
                {account_expired ? "登录状态已过期" : "账号操作失败"}
              </AlertTitle>
              <AlertDescription>
                {error ?? "请重新登录抖音并更新 Cookie 后再次测试。"}
              </AlertDescription>
            </Alert>
          </CardFooter>
        ) : account ? (
          <CardFooter className="justify-end">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => void on_disconnect()}
              disabled={is_loading}
            >
              <LogOut data-icon="inline-start" />
              断开账号
            </Button>
          </CardFooter>
        ) : null}
      </Card>

      <Dialog open={dialog_open} onOpenChange={set_dialog_open}>
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {account ? "重新登录抖音账号" : "连接抖音账号"}
            </DialogTitle>
            <DialogDescription>
              OpenVideo 不保存账号密码，只把必要 Cookie 保存到系统凭据库。
            </DialogDescription>
          </DialogHeader>
          <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
            <li>打开抖音网页版并完成登录。</li>
            <li>完全关闭浏览器，避免 Cookie 数据库被占用。</li>
            <li>选择刚才登录的浏览器并导入登录状态。</li>
          </ol>
          <Button
            type="button"
            variant="outline"
            onClick={() =>
              window.open(DOUYIN_LOGIN_URL, "_blank", "noopener,noreferrer")
            }
          >
            <ExternalLink data-icon="inline-start" />
            打开抖音网页版
          </Button>
          {error ? (
            <Alert variant="destructive">
              <TriangleAlert aria-hidden="true" />
              <AlertTitle>无法连接账号</AlertTitle>
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          ) : null}
          <FieldGroup>
            <Field data-disabled={is_loading}>
              <FieldLabel htmlFor="douyin_cookie_browser">
                登录浏览器
              </FieldLabel>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Select
                  value={browser}
                  onValueChange={(value) =>
                    set_browser(value as DownloadCookieBrowser)
                  }
                  disabled={is_loading}
                >
                  <SelectTrigger id="douyin_cookie_browser" className="flex-1">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent position="popper">
                    <SelectGroup>
                      <SelectItem value="edge">Microsoft Edge</SelectItem>
                      <SelectItem value="chrome">Google Chrome</SelectItem>
                      <SelectItem value="firefox">Mozilla Firefox</SelectItem>
                    </SelectGroup>
                  </SelectContent>
                </Select>
                <Button
                  type="button"
                  onClick={() => void import_from_browser()}
                  disabled={is_loading}
                >
                  {is_loading ? (
                    <Spinner data-icon="inline-start" />
                  ) : (
                    <LogIn data-icon="inline-start" />
                  )}
                  从浏览器导入
                </Button>
              </div>
              <FieldDescription>
                默认读取最近使用的浏览器配置；浏览器必须已经完全退出。
              </FieldDescription>
            </Field>
          </FieldGroup>
          <div className="flex items-center gap-3" aria-hidden="true">
            <Separator className="flex-1" />
            <span className="text-xs text-muted-foreground">或手动粘贴</span>
            <Separator className="flex-1" />
          </div>
          <form onSubmit={submit_cookie}>
            <FieldGroup>
              <Field data-invalid={Boolean(error)} data-disabled={is_loading}>
                <FieldLabel htmlFor="douyin_cookie">抖音 Cookie</FieldLabel>
                <Textarea
                  id="douyin_cookie"
                  value={cookie}
                  onChange={(event) => set_cookie(event.target.value)}
                  placeholder="sessionid=...; ttwid=...; ..."
                  rows={6}
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={Boolean(error)}
                  disabled={is_loading}
                />
                <FieldDescription>
                  Cookie 属于敏感凭据，请勿发送给他人或粘贴到公开页面。
                </FieldDescription>
              </Field>
            </FieldGroup>
            <Alert className="mt-4">
              <ShieldCheck aria-hidden="true" />
              <AlertTitle>本机安全保存</AlertTitle>
              <AlertDescription>
                配置文件只记录账号状态，Cookie 本身交给操作系统凭据库。
              </AlertDescription>
            </Alert>
            <DialogFooter className="mt-4">
              <Button
                type="button"
                variant="outline"
                onClick={() => set_dialog_open(false)}
                disabled={is_loading}
              >
                取消
              </Button>
              <Button type="submit" disabled={is_loading || !cookie.trim()}>
                {is_loading ? (
                  <Spinner data-icon="inline-start" />
                ) : (
                  <LogIn data-icon="inline-start" />
                )}
                保存 Cookie
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function account_status(account: DownloadAccount | null, is_loading: boolean) {
  if (is_loading)
    return { label: "处理中", variant: "outline" as const, icon: CircleDashed };
  if (!account)
    return { label: "未连接", variant: "outline" as const, icon: CircleDashed };
  if (account.status === "available")
    return {
      label: "可用",
      variant: "secondary" as const,
      icon: CheckCircle2,
    };
  if (account.status === "expired")
    return {
      label: "已过期",
      variant: "destructive" as const,
      icon: TriangleAlert,
    };
  return { label: "待测试", variant: "outline" as const, icon: CircleDashed };
}

function format_account_time(value: string): string {
  const time = new Date(value);
  return Number.isNaN(time.getTime())
    ? "未知"
    : new Intl.DateTimeFormat("zh-CN", {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(time);
}
