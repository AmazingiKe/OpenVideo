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
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import type {
  DownloadAccount,
  DownloadCookieBrowser,
  SourcePlatform,
} from "@/shared/types";

type PlatformAccountPresentation = {
  platform: SourcePlatform;
  label: string;
  login_url: string;
  cookie_placeholder: string;
};

const PLATFORM_ACCOUNTS: PlatformAccountPresentation[] = [
  {
    platform: "bilibili",
    label: "Bilibili",
    login_url: "https://passport.bilibili.com/login",
    cookie_placeholder: "SESSDATA=...; bili_jct=...; ...",
  },
  {
    platform: "douyin",
    label: "抖音",
    login_url: "https://www.douyin.com/",
    cookie_placeholder: "sessionid=...; ttwid=...; ...",
  },
  {
    platform: "youtube",
    label: "YouTube",
    login_url: "https://www.youtube.com/",
    cookie_placeholder: "SAPISID=...; SID=...; ...",
  },
];

type DownloadAccountsCardProps = {
  accounts: DownloadAccount[];
  loading_platform: SourcePlatform | null;
  errors: Partial<Record<SourcePlatform, string>>;
  on_save: (platform: SourcePlatform, cookie: string) => Promise<void>;
  on_import_browser: (
    platform: SourcePlatform,
    browser: DownloadCookieBrowser,
  ) => Promise<void>;
  on_test: (platform: SourcePlatform) => Promise<void>;
  on_disconnect: (platform: SourcePlatform) => Promise<void>;
};

export function DownloadAccountsCard({
  accounts,
  loading_platform,
  errors,
  on_save,
  on_import_browser,
  on_test,
  on_disconnect,
}: DownloadAccountsCardProps) {
  const [dialog_platform, set_dialog_platform] =
    useState<SourcePlatform | null>(null);
  const [cookie, set_cookie] = useState("");
  const [browser, set_browser] = useState<DownloadCookieBrowser>("edge");
  const dialog_presentation = PLATFORM_ACCOUNTS.find(
    ({ platform }) => platform === dialog_platform,
  );
  const dialog_account = accounts.find(
    ({ platform }) => platform === dialog_platform,
  );

  async function submit_cookie(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!dialog_platform) return;
    try {
      await on_save(dialog_platform, cookie);
      close_dialog();
    } catch {
      // 父级统一呈现 API 错误，保留输入便于用户修正后重试。
    }
  }

  async function import_from_browser() {
    if (!dialog_platform) return;
    try {
      await on_import_browser(dialog_platform, browser);
      close_dialog();
    } catch {
      // 父级统一呈现 API 错误，保留对话框以便切换浏览器重试。
    }
  }

  function close_dialog() {
    set_cookie("");
    set_dialog_platform(null);
  }

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
                平台账号
              </CardTitle>
              <CardDescription>
                登录状态会自动用于链接检测和高清资源下载。
              </CardDescription>
            </div>
          </div>
          <CardAction>
            <Badge variant="outline">{accounts.length}/3 已连接</Badge>
          </CardAction>
        </CardHeader>
        <CardContent className="flex flex-col gap-0">
          {PLATFORM_ACCOUNTS.map((presentation, index) => {
            const account = accounts.find(
              ({ platform }) => platform === presentation.platform,
            );
            const is_loading = loading_platform === presentation.platform;
            const error = errors[presentation.platform];
            const status = account_status(account, is_loading);
            const StatusIcon = status.icon;
            return (
              <section
                key={presentation.platform}
                className="flex flex-col gap-4 py-5 first:pt-0 last:pb-0"
                aria-labelledby={`${presentation.platform}_account_title`}
              >
                {index > 0 ? <Separator className="-mt-5" /> : null}
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                  <div className="flex min-w-0 flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3
                        id={`${presentation.platform}_account_title`}
                        className="font-medium"
                      >
                        {presentation.label}
                      </h3>
                      <Badge variant={status.variant}>
                        <StatusIcon data-icon="inline-start" />
                        {status.label}
                      </Badge>
                    </div>
                    <p className="text-sm text-muted-foreground">
                      {account?.last_tested_at
                        ? `上次测试：${format_account_time(account.last_tested_at)}`
                        : account
                          ? "Cookie 已保存，建议先测试可用性。"
                          : `登录 ${presentation.label} 网页版后导入 Cookie。`}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {account ? (
                      <Button
                        type="button"
                        variant="outline"
                        onClick={() => void on_test(presentation.platform)}
                        disabled={is_loading || account.status === "expired"}
                      >
                        {is_loading ? (
                          <Spinner data-icon="inline-start" />
                        ) : (
                          <RefreshCw data-icon="inline-start" />
                        )}
                        测试
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      onClick={() => set_dialog_platform(presentation.platform)}
                      disabled={is_loading}
                    >
                      <LogIn data-icon="inline-start" />
                      {account ? "重新登录" : "连接账号"}
                    </Button>
                    {account ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() =>
                          void on_disconnect(presentation.platform)
                        }
                        disabled={is_loading}
                      >
                        <LogOut data-icon="inline-start" />
                        断开
                      </Button>
                    ) : null}
                  </div>
                </div>
                {account?.status === "expired" || error ? (
                  <Alert variant="destructive">
                    <TriangleAlert aria-hidden="true" />
                    <AlertTitle>
                      {account?.status === "expired"
                        ? "登录状态已过期"
                        : "账号操作失败"}
                    </AlertTitle>
                    <AlertDescription>
                      {error ?? "请重新登录并更新 Cookie 后再次测试。"}
                    </AlertDescription>
                  </Alert>
                ) : null}
              </section>
            );
          })}
        </CardContent>
      </Card>

      <Dialog
        open={Boolean(dialog_presentation)}
        onOpenChange={(open) => {
          if (!open) close_dialog();
        }}
      >
        <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto sm:max-w-lg">
          {dialog_presentation ? (
            <>
              <DialogHeader>
                <DialogTitle>
                  {dialog_account ? "重新登录 " : "连接 "}
                  {dialog_presentation.label} 账号
                </DialogTitle>
                <DialogDescription>
                  OpenVideo 不保存账号密码，只把必要 Cookie 保存到系统凭据库。
                </DialogDescription>
              </DialogHeader>
              <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm text-muted-foreground">
                <li>打开对应平台网页版并完成登录。</li>
                <li>完全关闭浏览器，避免 Cookie 数据库被占用。</li>
                <li>选择刚才登录的浏览器并导入登录状态。</li>
              </ol>
              <Button
                type="button"
                variant="outline"
                onClick={() =>
                  window.open(
                    dialog_presentation.login_url,
                    "_blank",
                    "noopener,noreferrer",
                  )
                }
              >
                <ExternalLink data-icon="inline-start" />
                打开 {dialog_presentation.label} 网页版
              </Button>
              {errors[dialog_presentation.platform] ? (
                <Alert variant="destructive">
                  <TriangleAlert aria-hidden="true" />
                  <AlertTitle>无法连接账号</AlertTitle>
                  <AlertDescription>
                    {errors[dialog_presentation.platform]}
                  </AlertDescription>
                </Alert>
              ) : null}
              <FieldGroup>
                <Field data-disabled={Boolean(loading_platform)}>
                  <FieldLabel
                    htmlFor={`${dialog_presentation.platform}_browser`}
                  >
                    登录浏览器
                  </FieldLabel>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Select
                      value={browser}
                      onValueChange={(value) =>
                        set_browser(value as DownloadCookieBrowser)
                      }
                      disabled={Boolean(loading_platform)}
                    >
                      <SelectTrigger
                        id={`${dialog_presentation.platform}_browser`}
                        className="flex-1"
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent position="popper">
                        <SelectGroup>
                          <SelectItem value="edge">Microsoft Edge</SelectItem>
                          <SelectItem value="chrome">Google Chrome</SelectItem>
                          <SelectItem value="firefox">
                            Mozilla Firefox
                          </SelectItem>
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                    <Button
                      type="button"
                      onClick={() => void import_from_browser()}
                      disabled={Boolean(loading_platform)}
                    >
                      {loading_platform ? (
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
                <span className="text-xs text-muted-foreground">
                  或手动粘贴
                </span>
                <Separator className="flex-1" />
              </div>
              <form onSubmit={submit_cookie}>
                <FieldGroup>
                  <Field
                    data-invalid={Boolean(errors[dialog_presentation.platform])}
                    data-disabled={Boolean(loading_platform)}
                  >
                    <FieldLabel
                      htmlFor={`${dialog_presentation.platform}_cookie`}
                    >
                      {dialog_presentation.label} Cookie
                    </FieldLabel>
                    <Textarea
                      id={`${dialog_presentation.platform}_cookie`}
                      value={cookie}
                      onChange={(event) => set_cookie(event.target.value)}
                      placeholder={dialog_presentation.cookie_placeholder}
                      rows={6}
                      autoComplete="off"
                      spellCheck={false}
                      aria-invalid={Boolean(
                        errors[dialog_presentation.platform],
                      )}
                      disabled={Boolean(loading_platform)}
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
                    onClick={close_dialog}
                    disabled={Boolean(loading_platform)}
                  >
                    取消
                  </Button>
                  <Button
                    type="submit"
                    disabled={Boolean(loading_platform) || !cookie.trim()}
                  >
                    {loading_platform ? (
                      <Spinner data-icon="inline-start" />
                    ) : (
                      <LogIn data-icon="inline-start" />
                    )}
                    保存 Cookie
                  </Button>
                </DialogFooter>
              </form>
            </>
          ) : null}
        </DialogContent>
      </Dialog>
    </>
  );
}

function account_status(
  account: DownloadAccount | undefined,
  is_loading: boolean,
) {
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
