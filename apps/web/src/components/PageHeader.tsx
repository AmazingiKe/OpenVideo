import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";

type PageHeaderProps = {
  title_id: string;
  eyebrow: string;
  title: string;
  description: string;
  icon: LucideIcon;
  action?: ReactNode;
};

export function PageHeader({
  title_id,
  eyebrow,
  title,
  description,
  icon: Icon,
  action,
}: PageHeaderProps) {
  return (
    <header className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
      <div className="flex max-w-2xl flex-col gap-3">
        <span className="flex items-center gap-2 text-sm font-medium text-primary">
          <Icon aria-hidden="true" />
          {eyebrow}
        </span>
        <h1
          id={title_id}
          className="text-2xl font-semibold tracking-tight sm:text-3xl"
        >
          {title}
        </h1>
        <p className="text-sm leading-relaxed text-muted-foreground sm:text-base">
          {description}
        </p>
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </header>
  );
}
