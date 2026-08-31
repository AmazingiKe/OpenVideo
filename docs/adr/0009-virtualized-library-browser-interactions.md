# ADR 0009：采用虚拟化、可视框选与无障碍拖放重构视频库浏览器

- 状态：已接受
- 日期：2026-08-31

## 背景

视频库浏览器已经支持虚拟文件夹、网格与列表、缩略图尺寸、多选、框选、右键菜单、搜索、排序和拖入文件夹。当前实现直接渲染当前目录或搜索结果的全部项目，并在 React hook 中自行计算选择矩形、DOM 相交和原生 HTML 拖放状态。

这套实现能够覆盖小型资料库，但存在三个增长风险：

- 项目数量增长时，卡片 DOM、图片和交互监听器随结果总量线性增长。
- 框选几何、滚动、触摸和动态挂载都由业务代码承担，后续维护成本高。
- 原生 HTML 拖放缺少一致的触摸与键盘交互，虚拟行卸载后也不能稳定保留拖拽反馈。

视频库同时用于独立资料库页面和标记工作台的紧凑侧栏。重构必须保留现有视频卡片、shadcn/Radix 组件、语义颜色 Token、后端 API 和业务数据模型，不能引入另一套文件管理器 UI。

相关库提供了相互独立的成熟能力：

- [TanStack Virtual](https://tanstack.com/virtual/latest/docs/introduction) 提供无样式的列表和网格虚拟化，应用继续拥有 DOM 与视觉结构。
- [Viselect](https://simonwep.github.io/viselect/pages/frameworks/react.html) 提供 React 19 可视框选适配器、滚动选择和选择区域事件。
- [dnd kit React](https://dndkit.com/react/quickstart/) 提供当前 React 拖放 API；默认传感器覆盖指针与键盘，[DragOverlay](https://dndkit.com/react/components/drag-overlay/) 可在虚拟化源项目卸载后继续显示拖拽反馈。

## 决策

### 三个库只承担交互基础设施

采用以下依赖边界：

| 能力     | 依赖                      | 负责                                 | 不负责                           |
| -------- | ------------------------- | ------------------------------------ | -------------------------------- |
| 可见范围 | `@tanstack/react-virtual` | 计算和挂载可见行、overscan、滚动定位 | 排序、查询、选择和卡片样式       |
| 指针框选 | `@viselect/react`         | 选择区域、滚动跟随、可见元素相交事件 | 持久选择集合、键盘选择和业务动作 |
| 拖放     | `@dnd-kit/react`          | 拖拽源、文件夹落点、传感器和拖拽浮层 | 素材移动、乐观更新和错误处理     |

需要显式配置 dnd kit 传感器或自动滚动时，将对应公开包 `@dnd-kit/dom` 声明为直接依赖，不从未声明的传递依赖导入。采用当前 `@dnd-kit/react` API，不新增旧版 `@dnd-kit/core`、`@dnd-kit/sortable` 或 `@dnd-kit/utilities`。

TanStack Virtual 与 Viselect 使用当前稳定 v3 API。dnd kit 在 1.0 之前锁定精确版本，升级前必须核对迁移指南；最终精确版本由 `pnpm-lock.yaml` 记录。

```text
LibraryBrowser
├── 查询与业务修改：现有 React Query hooks
├── 选择、焦点与上下文目标：OpenVideo 状态
└── LibraryBrowserViewport
    ├── TanStack Virtual：挂载可见行
    ├── Viselect：把框选命中转换为 asset_id
    └── dnd kit：把拖放转换为 asset_ids + folder_id
```

任何第三方库的 DOM store、活动节点或索引都不得成为业务状态的权威源。业务操作始终使用现有 `asset_id` 和 `folder_id`；不新增持久化标识符。

### 使用虚拟行而不是 masonry lanes

网格视图按容器宽度和缩略图尺寸计算列数，再把“直接子文件夹在前、视频在后”的线性项目序列分组为虚拟行。列表视图使用同一虚拟行模型，每行一个项目。

不采用 masonry 或双轴虚拟化，原因是视频库需要稳定的行优先顺序、Shift 范围选择、键盘定位和可预测的响应式重排。视图模式、容器宽度或缩略图尺寸变化时重新测量虚拟行，并尽量以首个可见语义项目恢复滚动锚点。

虚拟化始终启用，不按项目数量保留“小列表直接渲染、大列表虚拟渲染”两套生产路径。React 19 下设置 `useFlushSync: false`，并且不启用 TanStack Virtual 的直接 DOM 更新模式，避免与 Viselect、dnd kit 和 React 焦点状态竞争。

### 选择状态独立于虚拟 DOM

`selected_asset_ids`、范围选择锚点、当前文件夹选择和聚焦项目继续由 OpenVideo 管理。语义保持不变：

- 普通点击只选择一个视频。
- Ctrl/Cmd 点击切换单个视频，Shift 点击按完整查询结果顺序选择范围。
- Ctrl/Cmd+A 选择当前文件夹或搜索结果中的全部已加载视频，不限于当前挂载项目。
- 文件夹保持单选，并清空视频选择。
- 切换文件夹或查询结果后，删除已不可见的选择。

Viselect 只处理细粒度指针设备上的空白区域框选。它通过 `asset_id` 把 `added` 和 `removed` 元素变化同步到一次框选手势的状态快照；虚拟项目卸载时保留已经确定的语义选择，虚拟范围变化后调用公开 API 重新解析当前可选元素。React 状态负责卡片选中样式，Viselect 的 DOM store 不负责恢复样式。

触摸设备优先保留滚动、点击和长按拖动，不启用触摸框选。框选区域样式只能在 `apps/web/src/styles.css` 中使用现有或新增的全局语义 Token，不能使用库示例中的原始颜色。

完成替换后删除自写矩形标准化、相交计算和手势指针捕获代码。文件夹祖先与后代判断迁移到语义明确的 `library_folder_tree.ts`，不保留旧文件别名或转发包装。

### 拖放只表达“把视频移动到文件夹”

视频卡片使用 `useDraggable`，文件夹卡片使用 `useDroppable`。不使用 sortable API，因为视频库不允许通过拖动重排视频或文件夹。

拖动一个未选择视频时，先将它设为唯一选择；拖动已选择视频时，拖拽载荷包含全部 `selected_asset_ids`。释放到有效文件夹后只调用现有 `move_assets_to_folder`，继续由现有 mutation 负责请求、刷新和错误反馈。

`DragDropProvider` 只包围视频库项目表面。每个 Provider 只渲染一个位于虚拟行之外的 `DragOverlay`，浮层显示一个视频标题或“共 N 个视频”，不得复制完整可交互卡片。自动滚动只作用于视频库滚动容器；只有当前挂载且可见的文件夹能够成为落点。

dnd kit 默认键盘传感器不得移除。选择后点击“移动”并使用现有文件夹对话框仍是完整的键盘和读屏等价路径，因此拖放是快捷操作而不是唯一操作。拖拽开始、当前文件夹落点、完成和取消必须通过可读状态反馈，`prefers-reduced-motion` 下禁用非必要位移动画。

### 保留现有业务与视觉边界

以下部分不在本次重构范围内：

- 后端列表、搜索、排序、文件夹和移动 API。
- React Query 查询键、缓存刷新和错误模型。
- `LibraryBrowserToolbar`、`LibraryBrowserDialogs` 和视频卡片视觉内容。
- 独立视频库页面与标记工作台侧栏的公开 `LibraryBrowser` props。
- 服务端分页、无限加载、文件上传和视频播放器。

不引入第三方文件管理器、主题、字体、图标或卡片组件。项目继续使用 shadcn/Radix、Lucide 和 `styles.css` 的语义 Design Tokens。

## 重构阶段

### 阶段一：锁定行为与职责

- 补充大规模资料库 Storybook fixture，以及网格、列表、紧凑侧栏和错误状态基线。
- 将选择、焦点、上下文目标与拖拽临时状态分开，使 `use_library_browser_selection` 只持有选择领域规则。
- 每个阶段先补测试再删除被替代代码，不保留兼容别名。

### 阶段二：用 Viselect 替换自写框选

- 接入 `SelectionArea`，以 `asset_id` 同步选择变化。
- 覆盖普通框选、Ctrl/Cmd 追加、滚动框选、取消和查询结果变化。
- 删除矩形相交代码，将文件夹树函数迁移到独立领域模块。

### 阶段三：接入 TanStack Virtual

- 新增单一 `LibraryBrowserViewport`，统一渲染网格和列表虚拟行。
- 对响应式列数、缩略图尺寸、动态行高、滚动锚点和虚拟范围变化建立测试。
- 验证 Viselect 只绑定当前挂载视频，而语义选择在卸载和重新挂载后保持。

### 阶段四：用 dnd kit 替换原生拖放

- 新增视频 draggable、文件夹 droppable 和单例 `DragOverlay`。
- 覆盖单选拖动、多选拖动、无效落点、自动滚动、取消和 mutation 失败。
- 删除 `DragEvent`、`dataTransfer` 和手写 `dragging_asset_ids/drop_folder_id` 生命周期。

### 阶段五：清理与验证

- 删除所有旧几何与原生拖放代码、无用测试和死导入。
- 更新依赖说明和 Storybook stories。
- 完成单元测试、Storybook 浏览器测试、无障碍测试、类型检查、lint 和生产构建。

## 验收

- 现有视频库功能和公开 props 不变，独立页面与标记工作台侧栏均通过回归测试。
- 10,000 个项目的 Story 中，挂载的项目 DOM 数量只由可见行与 overscan 决定，不随结果总量线性增长。
- 网格、列表、缩略图尺寸、搜索、排序、面包屑和紧凑模式在虚拟化后行为一致。
- 普通点击、Ctrl/Cmd、Shift、Ctrl/Cmd+A、Space、Enter、Escape、Backspace 和 Alt+Left 行为一致。
- 框选可随容器滚动；已选视频离开虚拟范围后仍在语义选择集合中，重新挂载时恢复选中状态。
- 单个或多个视频可以拖入文件夹；源卡片卸载后拖拽浮层仍存在；取消和无效落点不触发 mutation。
- 仅使用键盘或读屏也可以通过“移动”按钮完成相同业务操作，拖放状态具有实时文本反馈。
- 360px、常规桌面宽度、浅色、深色和 reduced motion 均通过视觉检查。
- 页面滚动时没有 React 19 `flushSync` 警告、重复 key、失焦异常或未处理 Promise。
- `pnpm --dir apps/web lint`、`check`、`test`、`test:storybook`、`build` 和 `build-storybook` 全部通过。

## 被否决的方案

- 整体接入通用文件管理器：会引入第二套视觉系统，并丢失视频状态、时长、作者和工作台紧凑模式等领域表达。
- 继续维护全部自研交互：无法降低几何、触摸、滚动、虚拟化和无障碍维护成本。
- 使用 dnd kit sortable：本领域只有“视频移动到文件夹”，没有用户定义顺序，sortable 会引入不存在的业务语义。
- 使用 masonry lanes：视觉顺序和数据顺序可能分离，不利于 Shift 范围选择、键盘导航和响应式重排。
- 仅在大数据量启用虚拟化：会形成两套渲染和交互路径，测试与缺陷面翻倍。
- 让 Viselect DOM store 保存选择：虚拟项目卸载后会丢失状态，也无法正确实现全结果范围选择。
- 一次性重写整个 `LibraryBrowser`：难以逐步验证回归，也会把查询、业务 mutation 和视觉组件卷入无关变更。

## 回滚

本决策不修改后端 API、资料库格式或持久化数据。任一阶段未通过验收时，可以回滚该阶段的前端依赖和实现，不需要数据迁移。

完成重构后不得长期保留旧实现、运行时功能开关或新旧两套命名；回滚必须通过版本控制恢复完整的上一实现。

## 结果

- 大型视频库的 DOM 与图片成本受视口范围限制。
- 框选、拖放和虚拟化由成熟库处理，OpenVideo 只保留领域选择和业务 mutation。
- 视频库视觉、数据模型、可访问操作和两个使用场景保持一致。
- 后续若增加服务端分页，可以在不重写交互层的前提下扩展数据层。
