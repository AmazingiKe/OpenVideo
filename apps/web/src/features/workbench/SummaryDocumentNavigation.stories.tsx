import type { Meta, StoryObj } from "@storybook/react-vite";

import type { SummaryDocument } from "@/shared/types";
import { SummaryDocumentNavigation } from "./SummaryDocumentNavigation";

const CREATED_AT = "2026-08-30T00:00:00Z";
const ROOT_ID = "document-0198dbf212347abc8123456789abcdef";
const CHILD_ID = "document-0198dbf312347abc8123456789abcdef";

function document(
  document_id: string,
  title: string,
  parent_document_id: string | null,
  position: number,
): SummaryDocument {
  return {
    document_id,
    asset_id: "asset-0198dbf112347abc8123456789abcdef",
    version_id: "summary-version-0198dbfa12347abc8123456789abcdef",
    parent_document_id,
    title,
    markdown: "",
    relative_path: parent_document_id ? `docs/${document_id}.md` : "index.md",
    content_digest: "storybook-digest",
    position,
    revision: 1,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  };
}

const DOCUMENTS = [
  document(ROOT_ID, "镜头语言课程笔记", null, 0),
  document(CHILD_ID, "案例拆解", ROOT_ID, 0),
  document(
    "document-0198dbf412347abc8123456789abcdef",
    "推轨镜头公式",
    CHILD_ID,
    0,
  ),
  document("document-0198dbf512347abc8123456789abcdef", "复习问题", ROOT_ID, 1),
];

const meta = {
  title: "Summary/DocumentNavigation",
  component: SummaryDocumentNavigation,
  args: {
    active_heading_id: "核心结论",
    documents: DOCUMENTS,
    markdown:
      "# 镜头语言课程笔记\n\n## 核心结论\n\n### 景别\n\n### 运动\n\n## 复习问题",
    selected_document_id: ROOT_ID,
    on_create: () => undefined,
    on_delete: () => undefined,
    on_duplicate: () => undefined,
    on_heading_select: () => undefined,
    on_move: () => undefined,
    on_rename: () => undefined,
    on_select: () => undefined,
    reordering: false,
  },
  decorators: [
    (StoryComponent) => (
      <div className="h-[640px] w-80 bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
} satisfies Meta<typeof SummaryDocumentNavigation>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Documents: Story = {};

export const Dark: Story = {
  decorators: [
    (StoryComponent) => (
      <div className="dark h-[640px] w-80 bg-background text-foreground">
        <StoryComponent />
      </div>
    ),
  ],
};
