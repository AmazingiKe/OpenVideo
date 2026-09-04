# AI Agent项目协作规则

## Git 提交

- 所有 Git 提交信息必须使用 `<类型>(<范围>): <中文说明>` 格式；范围可省略。
- 类型使用小写英文前缀，根据变更性质选择 `feat`、`fix`、`refactor`、`docs`、`test`、`chore`、`build`、`ci`、`perf`、`style` 或 `revert`。
- 中文说明应简洁描述本次变更的目的和范围，不得省略类型前缀。
- commit的内容只能是中文，禁止英文或拼音。
- commit 只能 commit自己修改的内容，不可以 commit 其他人修改的内容。
- commit 的时候最好分批提交，避免一次提交过多内容，导致代码难以回溯和理解。

## 代码质量（AI 必须遵守）

本项目的架构分为 core / maya / tools / ui 四层。以下规则用于约束 AI 生成或重构的代码，防止出现"结构正确但难以阅读"的产物。

### 1. 单一命名，禁止别名

- 每个功能只允许一个名字。禁止定义语义别名，例如 `uv_preset_menu = set_uv_preset`、`magic_connection_button = run_magic_connection`、`AMS_Config = AMS_CONFIG`。
- 重命名或迁移时，直接修改所有调用点并删除旧名，禁止保留旧名"兼容"。

反例（禁止）：

```python
uv_preset_menu = set_uv_preset
AutoSet_TexColorSpace = auto_set_texture_color_space
```

### 2. 禁止冗余包装

- 禁止写与父类行为完全一致、仅转发参数的 `super()` 方法。
- 禁止写"只调用另一个函数、不增加任何行为"的包装函数。
- 仅当存在真实行为差异（参数变换、校验、适配、状态变更）时才允许包装，且 docstring 必须写清差异。

反例（禁止）：

```python
def file_texture_path(self, node_name):
    return super().file_texture_path(node_name)
```

### 3. 禁止调试残留与死代码

- 禁止 if/else 两个分支执行相同逻辑、未使用的局部变量、被注释掉的代码块。
- 业务代码中面向用户的提示统一走 `FeedbackPrompt`，禁止裸 `print`。

反例（禁止）：

```python
def report(self, message, warning=False):
    if warning:
        self.warning(message)
    else:
        self.warning(message)
```

### 4. 命名与缩写规范

- 函数/变量用 `snake_case`，类用 `PascalCase`，常量用 `UPPER_SNAKE_CASE`，禁止驼峰命名。
- 禁止无意义缩写：`CP/CPW/CPE` 必须写成 `print_message/warn/raise_error`；`process_sl_data` 必须写成 `process_selected_nodes`。
- i18n 语言文件键禁止拼音缩写（如 `xryssz_menu`），必须使用语义化英文键。

### 5. docstring 规范

- docstring 必须解释"为什么存在"与领域含义，禁止复述函数名或参数。
- 保留任何兼容层时必须写 `TODO(删除)：在 <条件> 后删除` 并说明触发条件；没有删除计划的兼容层视为违规。

反例（禁止）：

```python
class DataManager:
    """旧 UI 所需的 JSON 读写兼容接口。"""
```

### 6. 禁止反射与魔术字符串

- 禁止用字符串反射调用方法：`getattr(obj, "CP", None)`。
- 禁止用魔术字符串索引嵌套配置字典；配置键名必须通过常量或数据模型集中定义，不得散落在业务代码中。

### 7. 重构原则：先删后加

- 重构/迁移优先删除旧代码并修改调用点，而非保留兼容层。
- 确需临时兼容层时，必须：集中在单个文件、带 `TODO(删除)` 与触发条件、不进入 `__all__` 公开面。
- 一次重构完成后，仓库不得残留"新旧两套命名"并存的状态。

### 8. 导入规范：禁止跨包相对导入

- 跨包导入（core / maya / tools / ui 之间）必须使用绝对导入，以包名 `arnold_magic_node` 开头。
- 禁止跨包使用 `..` 相对导入（如 `from ..core.xxx`、`from ..maya.xxx`），因为它要求读者先定位当前文件层级，不直观。
- 同一包内相邻模块可用单点相对导入 `from .xxx import`。

反例（禁止）：

```python
from ..core.magic_connection import build_magic_connection_plan
from ..maya.magic_connection import MayaMagicConnectionExecutor
```

正例：

```python
from arnold_magic_node.core.magic_connection import build_magic_connection_plan
```

### 9. 架构克制：按需架构、内聚不散

- 只有当一个抽象承担真实职责（有行为差异、会被复用、能独立测试）时才引入分层或包装；禁止"为了分层而分层"。
- 判定标准：删掉某个类/层后，调用方只需改 import 且行为不变 → 它就是过度包装，应删除并直接调用被转发的那一层。
- 同一领域逻辑必须内聚在同一个模块，禁止散落到多个文件。

反例（禁止）：

```python
def ensure_runtime_directory(directory_path):
    return ensure_directory(directory_path)   # 纯转发，应直接调用 ensure_directory
```

### 10. 注释规范：清楚简洁、必要才写

- 注释解释"为什么"，不解释"是什么"；禁止复述代码本身的注释。
- 显而易见的代码不写注释；简单赋值、简单调用不写行尾注释。
- 仅在复杂逻辑、非显而易见的决策、领域术语、外部约束处写注释，且一句话说清原因。

反例（禁止）：

```python
config = load_json(path)   # 加载配置        # 禁止：复述代码
i += 1                     # i 加 1          # 禁止：显而易见
```

正例：

```python
# file 节点灰度通道用 outAlpha 输出，颜色通道才用 outColor
if channel in GRAY_CHANNELS:
    ...
```

### 11. 禁止魔法代码与冗长表达式

- 魔法数字、魔法字符串禁止直接出现在逻辑中；必须提取为命名常量并说明含义。
- 冗长表达式必须拆分为命名清晰的中间变量或小函数；禁止一行写满深层嵌套的调用、索引或链式表达式。

反例（禁止）：

```python
for node in cmds.ls(type="file"):
    if os.path.getmtime(cmds.getAttr(node + ".fileTextureName")) > t:
        ...
```

正例：

```python
def file_texture_path(node):
    return cmds.getAttr(node + ".fileTextureName")

for node in cmds.ls(type="file"):
    if os.path.getmtime(file_texture_path(node)) > threshold:
        ...
```

### 12. 标识符规范（UUIDv7）

- 所有对外持久化的标识符（资源、任务、片段、标记等）必须使用 **UUIDv7**（RFC 9562），禁止 `uuid4`、`crypto.randomUUID()` 或自增整数作为对外标识符。
- UUIDv7 生成必须走统一工具，禁止在业务代码中各自实现：
  - 后端：`openvideo.core.identifiers.uuid7`
  - 前端：`apps/web/src/identifiers.ts` 的 `uuid7`
- 对外标识符格式为「语义前缀 + uuid7 十六进制」，例如 `asset-{uuid7.hex}`、`job-{uuid7.hex}`；校验时按前缀 + 定长十六进制处理，不允许把前缀或用户输入拼进文件路径。
- 新增标识符字段时同样使用 UUIDv7，不得引入其他 ID 方案。

## 前端设计系统与组件复用

- 开始实现 UI 前，先搜索 `apps/web` 现有组件、Storybook 文档和 shadcn registry；已有组件能够组合完成时，禁止重复造组件。
- 重复出现的 UI 或交互必须抽成单一 reusable component，并为可复用组件维护 Storybook stories。
- 颜色、间距、圆角、阴影、字号和动效必须使用语义化 Design Tokens，禁止在业务组件中随意 hardcode color/spacing。
- 所有手写前端代码（包括 CSS、TSX、SVG 和 Canvas 绘制代码）只能使用 `apps/web/src/styles.css` 中集中定义的语义颜色 Token；该文件是前端颜色 Token 的唯一来源。
- 禁止在组件、页面或局部 CSS 中新增颜色变量、局部 CSS 自定义属性或临时色值，不得以局部变量间接包装颜色来绕过全局 Token 约束。
- 禁止直接使用十六进制、`rgb()`、`hsl()`、`oklch()` 等颜色值、Tailwind 原始色阶、内联颜色以及手写 `dark:` 配色。
- 新增颜色需求必须先在全局 Token 系统中定义语义名称，再由组件调用；播放器、时间线等领域颜色也必须定义为集中管理的领域语义 Token。
- 第三方依赖、生成文件以及图片或视频本身的像素颜色不受上述颜色 Token 规则约束。
- 布局遵循 8px Grid；仅在紧凑内部对齐且已有 token 时使用 4px 半步。Typography 必须形成清晰的标题、正文、标签和元数据层级。
- 保持专业 SaaS/Tool UI 的 Visual Hierarchy，突出主任务与状态，弱化次要操作和装饰效果。
- 所有界面必须设计 Responsive Layout，并验证键盘操作、焦点、语义 HTML、ARIA、对比度及 reduced motion 等 Accessibility 要求。
- Light/Dark Mode 必须共用语义 token，并覆盖 hover、focus、selected、disabled、loading、empty、success、warning、error 状态。
- 优先采用 shadcn/ui、Radix UI、Lucide 和现有项目组件；Motion Primitives、Magic UI、Aceternity UI 仅在确有功能价值时按需引入。

### 13. 在回复内容

- 在回答工作问题的时候，尽量用简洁的语言去回答，不要用冗长的语言去描述，如果要表达某一个结果，请用一些可视化，比如说列表等方式去展示，不要用冗长的文字去表达

### 14. OpenVideo 配置目录

- OpenVideo 生成的所有应用配置文件必须统一保存在系统用户配置目录 `user_config_path("OpenVideo", appauthor=False)`；Windows 对应 `%LOCALAPPDATA%\OpenVideo`。
- 禁止把应用配置写入项目目录、`runtime`、程序安装目录或资料库目录。资料库清单、数据库、素材元数据和缓存属于业务数据，不视为应用配置。
- 配置目录必须通过 `openvideo.configuration.OPENVIDEO_CONFIG_DIRECTORY` 获取，禁止在业务代码中重复拼接或定义其他配置根目录。
