# ADR 0002：采用三态模型能力解析与 Agno Agent Runtime

- 状态：已接受
- 日期：2026-08-27

## 背景

OpenVideo 通过 LiteLLM 接入不同模型。旧 Agent Runtime 在请求前调用 `litellm.supports_function_calling(model)`，并把返回的 `False` 直接解释为模型不支持工具调用。LiteLLM 的静态模型表无法及时识别实验模型、自定义模型名和部分 Provider 新能力，因此会在真实请求前错误阻止可用模型。

旧实现还自行处理工具 Schema、Provider 消息格式、流式工具参数、工具结果回传和多轮工具循环。这些协议细节随 Provider 演进而变化，已经出现 DeepSeek Thinking 与 `tool_choice` 组合错误被误分类为“不支持工具调用”的问题。

模型是否具备某项能力、某个 Provider 有哪些参数限制，以及 Agent 如何执行，是三个不同职责，必须分开处理。

## 决策

### 模型能力使用三态

所有 Agent 能力统一表示为：

```text
YES      已确认支持
NO       已确认不支持
UNKNOWN  当前证据不足
```

Agent 启动规则为：

```text
YES      直接运行
UNKNOWN  允许真实尝试
NO       请求前阻止
```

静态模型目录未识别模型或返回否定结果，不足以单独产生 `NO`。只有用户明确禁用、可信本地覆盖、Runtime Probe 获得明确协议拒绝等证据，才能确认不支持。

### 统一生成 ModelProfile

能力解析器按照以下优先级生成最终 `ModelProfile`：

```text
用户显式覆盖
→ Runtime Probe 已确认结果
→ 本地精确模型覆盖
→ Provider 与模型家族规则
→ models.dev 在线模型目录
→ LiteLLM 辅助元数据
→ UNKNOWN
```

`ModelProfile` 同时包含能力、每项能力的证据来源、Provider 特殊规则、上下文窗口和输出限制。业务 Agent 只能使用 `ModelProfile`，不得直接调用 LiteLLM 静态能力判断。

用户能力覆盖采用：

```text
auto      由解析器决定
enabled   允许真实尝试
disabled  明确禁用
```

### models.dev 只提供基础能力

models.dev 用于查询工具调用、推理、输入模态、结构化输出、上下文窗口和最大输出长度。查询结果缓存在 OpenVideo 系统配置目录中；在线服务不可用时使用已有缓存，未收录的模型返回 `UNKNOWN`，不得阻止运行。

models.dev 不是协议兼容性的最终裁判，也不负责描述 Provider 的特殊参数组合。

### Provider 特殊行为由 Local Quirks 描述

特殊规则集中保存在 `openvideo/llm/quirks.yaml`，按照 Provider 默认、模型家族和精确模型三层合并。业务代码不得散落基于模型名称的条件分支。

DeepSeek 采用以下规则：

- 非推理工具调用发送 `thinking={"type": "disabled"}` 与 `tool_choice="auto"`。
- 推理与工具同时启用时不发送指定函数的 `tool_choice`。
- 用户要求指定工具时，优先关闭 Thinking。
- 保留 `reasoning_content`，并满足 DeepSeek 对 assistant content 的协议要求。

`Thinking + named tool_choice` 被拒绝时，错误类型是 `FeatureCombinationUnsupportedError`，不是 `ToolCallingUnsupportedError`。

### Runtime Probe 只验证单项能力

真实探测拆分为基础工具、流式工具、推理加工具、指定工具、并行工具和图片加工具。基础工具探测固定使用：

```python
thinking={"type": "disabled"}
tool_choice="auto"
stream=False
```

探测结果按 Provider、API 地址、模型、协议和 SDK 版本缓存。探测参数错误、网络错误和未知 Provider 错误保留为 `UNKNOWN`；只有明确的能力拒绝才记录为 `NO`。

Probe 在添加或测试模型、修改 Provider 配置、缓存失效，以及未知能力首次实际需要时运行。普通 Agent 请求不得每次重复探测。

### Agent Runtime 由 Agno 执行

Agent 和 Tool Calling 场景优先使用 Agno Native Provider：

```text
OpenAI      OpenAIChat
Anthropic   Claude
Google      Gemini
DeepSeek    DeepSeek
Qwen        DashScope
xAI         xAI
Mistral     MistralChat
OpenRouter  OpenRouter
Ollama      Ollama
其他兼容服务 OpenAILike
```

Agno 负责工具 Schema、工具调用与结果回传、Agent 循环、流式协议、Provider 消息格式和推理内容。OpenVideo 负责会话、运行状态、取消、超时、工具授权、业务审批、事件持久化和 SSE 恢复。

OpenVideo 将 Agno 事件映射为统一内部事件：文本增量、推理增量、工具调用开始与完成、响应完成和响应失败。UI 不得依赖任一 Provider 的原始响应结构。

### LiteLLM 保留普通调用职责

LiteLLM 继续用于普通 Chat、兼容网关、基础能力探测以及成本、限流、负载均衡等非 Agent 场景。`supports_function_calling()` 只能提供正向辅助证据；它返回 `False` 时必须转换为 `UNKNOWN`，不能直接阻止 Agent。

## 被否决的方案

- **继续维护模型名称白名单**：无法可靠覆盖实验模型和自定义 Provider，并会持续产生滞后的静态判断。
- **把所有未知能力当作不支持**：安全但会错误拒绝实际可用模型，不符合开放模型接入目标。
- **只修复 DeepSeek 探测参数**：能够修复当前模型，但不会解决能力来源、错误分类和其他 Provider 的同类问题。
- **保留 LiteLLM 与 Agno 两套 Agent Runtime**：会造成工具循环、事件语义和错误处理继续分叉，因此旧 LiteLLM Agent Runtime 被删除。

## 结果

- 新模型和实验模型默认可以真实尝试，不再因静态目录滞后而失败。
- 已确认不支持的模型仍会在请求前得到明确错误。
- DeepSeek Thinking 与 Tool Calling 的组合限制由数据驱动规则统一处理。
- Tool Calling Provider 协议由 Agno 维护，OpenVideo 保留业务运行时控制权。
- 模型设置界面可以展示每项能力的三态、证据来源和 Runtime Probe 结果。
- 增加了 Agno 和 PyYAML 依赖；显式模型测试会产生少量真实模型请求和相应费用。
- 未知 OpenAI-Compatible Provider 仍可能存在协议差异，但失败会被保留为具体 Provider 或特性组合错误，不再统一误报为工具能力不足。
