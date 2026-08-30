import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import {
  BoldIcon,
  CodeIcon,
  Heading1Icon,
  Heading2Icon,
  Heading3Icon,
  ItalicIcon,
  LinkIcon,
  ListChecksIcon,
  ListIcon,
  ListOrderedIcon,
  PilcrowIcon,
  SigmaIcon,
  StrikethroughIcon,
  TextQuoteIcon,
} from "lucide-react";

import {
  ContextMenu,
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuGroup,
  ContextMenuLabel,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

export type MarkdownBlockStyle =
  | "paragraph"
  | "heading-1"
  | "heading-2"
  | "heading-3"
  | "quote"
  | "bullet-list"
  | "ordered-list"
  | "task-list"
  | "code-block";

export type MarkdownInlineStyle =
  "bold" | "italic" | "strikethrough" | "inline-code" | "inline-math" | "link";

export type MarkdownFormattingState = {
  block_style: MarkdownBlockStyle;
  bold: boolean;
  italic: boolean;
  strikethrough: boolean;
  inline_code: boolean;
  inline_math: boolean;
  link: boolean;
};

export const EMPTY_MARKDOWN_FORMATTING_STATE: MarkdownFormattingState = {
  block_style: "paragraph",
  bold: false,
  italic: false,
  strikethrough: false,
  inline_code: false,
  inline_math: false,
  link: false,
};

type MarkdownEditorContextMenuProps = {
  children: ReactNode;
  enabled: boolean;
  formatting_state: MarkdownFormattingState;
  on_block_style: (style: MarkdownBlockStyle) => void;
  on_inline_style: (style: MarkdownInlineStyle) => void;
  on_open_change: (open: boolean) => void;
};

type BlockStyleItem = {
  icon: LucideIcon;
  label: string;
  style: MarkdownBlockStyle;
};

type InlineStyleItem = {
  aria_shortcut?: string;
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  state_key: Exclude<keyof MarkdownFormattingState, "block_style">;
  style: MarkdownInlineStyle;
};

const BLOCK_STYLE_ITEMS: readonly BlockStyleItem[] = [
  { style: "paragraph", label: "正文", icon: PilcrowIcon },
  { style: "heading-1", label: "一级标题", icon: Heading1Icon },
  { style: "heading-2", label: "二级标题", icon: Heading2Icon },
  { style: "heading-3", label: "三级标题", icon: Heading3Icon },
  { style: "quote", label: "引用", icon: TextQuoteIcon },
  { style: "bullet-list", label: "项目列表", icon: ListIcon },
  { style: "ordered-list", label: "编号列表", icon: ListOrderedIcon },
  { style: "task-list", label: "任务列表", icon: ListChecksIcon },
  { style: "code-block", label: "代码块", icon: CodeIcon },
];

const INLINE_STYLE_ITEMS: readonly InlineStyleItem[] = [
  {
    style: "bold",
    state_key: "bold",
    label: "粗体",
    icon: BoldIcon,
    shortcut: "Ctrl+B",
    aria_shortcut: "Control+B",
  },
  {
    style: "italic",
    state_key: "italic",
    label: "斜体",
    icon: ItalicIcon,
    shortcut: "Ctrl+I",
    aria_shortcut: "Control+I",
  },
  {
    style: "strikethrough",
    state_key: "strikethrough",
    label: "删除线",
    icon: StrikethroughIcon,
    shortcut: "Ctrl+Alt+X",
    aria_shortcut: "Control+Alt+X",
  },
  {
    style: "inline-code",
    state_key: "inline_code",
    label: "行内代码",
    icon: CodeIcon,
    shortcut: "Ctrl+E",
    aria_shortcut: "Control+E",
  },
  {
    style: "inline-math",
    state_key: "inline_math",
    label: "行内公式",
    icon: SigmaIcon,
  },
  {
    style: "link",
    state_key: "link",
    label: "链接",
    icon: LinkIcon,
  },
];

export function MarkdownEditorContextMenu({
  children,
  enabled,
  formatting_state,
  on_block_style,
  on_inline_style,
  on_open_change,
}: MarkdownEditorContextMenuProps) {
  return (
    <ContextMenu onOpenChange={on_open_change}>
      <ContextMenuTrigger asChild disabled={!enabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent className="min-w-52" aria-label="文字格式">
        <ContextMenuGroup>
          <ContextMenuLabel>文字格式</ContextMenuLabel>
          {INLINE_STYLE_ITEMS.map((item) => {
            const Icon = item.icon;
            return (
              <ContextMenuCheckboxItem
                key={item.style}
                checked={formatting_state[item.state_key]}
                aria-keyshortcuts={item.aria_shortcut}
                onSelect={() => on_inline_style(item.style)}
              >
                <Icon aria-hidden="true" />
                {item.label}
                {item.shortcut ? (
                  <ContextMenuShortcut>{item.shortcut}</ContextMenuShortcut>
                ) : null}
              </ContextMenuCheckboxItem>
            );
          })}
        </ContextMenuGroup>
        <ContextMenuSeparator />
        <ContextMenuSub>
          <ContextMenuSubTrigger>
            <PilcrowIcon aria-hidden="true" />
            段落样式
          </ContextMenuSubTrigger>
          <ContextMenuSubContent className="min-w-44">
            <ContextMenuRadioGroup value={formatting_state.block_style}>
              {BLOCK_STYLE_ITEMS.map((item) => {
                const Icon = item.icon;
                return (
                  <ContextMenuRadioItem
                    key={item.style}
                    value={item.style}
                    onSelect={() => on_block_style(item.style)}
                  >
                    <Icon aria-hidden="true" />
                    {item.label}
                  </ContextMenuRadioItem>
                );
              })}
            </ContextMenuRadioGroup>
          </ContextMenuSubContent>
        </ContextMenuSub>
      </ContextMenuContent>
    </ContextMenu>
  );
}
