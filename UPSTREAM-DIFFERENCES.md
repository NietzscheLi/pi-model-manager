# 与上游 Pi 的差异

本文记录 `pi-model-manager` 相对于上游 Pi Coding Agent 的功能边界和行为差异。

> 上游仓库：[`earendil-works/pi`](https://github.com/earendil-works/pi)
>
> 本项目是 Pi 扩展，不是 Pi 核心的 fork。它通过 `/model-manager` 管理 Pi 的原生配置文件，因此不会替换或修改 Pi 核心的模型注册、请求和余额查询实现。

## 功能差异

| 功能 | 上游 Pi | `pi-model-manager` |
| --- | --- | --- |
| Provider / Model 编辑 | 主要通过 `models.json` 或其它配置入口维护 | 提供 `/model-manager` TUI，可新增、编辑、删除 Provider 和 Model |
| 模型元数据 | 使用配置中已有的模型字段 | 保存模型时可从 `models.dev` 或 OpenRouter 同步 context、max tokens、输入模态、推理能力、thinking level 和 cost |
| 元数据来源 | 无本扩展提供的来源选择器 | 默认 `models.dev`，也支持 OpenRouter 和手工保留 |
| 请求头身份 | 使用 Pi 原生 Provider 行为 | 增加 Recommended、Disabled、Claude Code、Codex 和可复用 Custom profile |
| 本地代理 | 由系统网络设置决定 | 支持按 Provider 配置 HTTP(S) 代理开关与地址；请求路由和模型发现都走代理 |
| 模型 API 协议 | 模型继承 Provider 协议 | 可在模型级覆盖 Responses / Chat / Claude / Gemini，未覆盖时继承 Provider |
| 多 API key | 每个 Provider 一个 apiKey | 每个 Provider 可维护多个命名 key，模型可按需选择（默认 key 仍写入 `models.json`） |
| 配置保存 | 由配置文件自身负责 | 使用跨进程锁、内容签名和可恢复事务，避免并发保存覆盖配置 |
| 界面语言 | 使用 Pi 默认界面语言 | 扩展界面默认简体中文，可按 `L` 切换 English |

## 配置文件边界

本项目不会把用户运行时配置提交到仓库，也不会使用仓库目录作为配置目录：

- Pi 原生模型配置：`~/.pi/agent/models.json`
- 扩展私有状态：`~/.pi/agent/extensions/pi-model-manager/state.json`
- 配置事务文件：`~/.pi/agent/extensions/pi-model-manager/config-transaction.json`

代理开关/地址、命名 API key（`apiKeys`）和模型的 key 选择（`apiKeyId`）只保存在 `state.json` 私有元数据；`models.json` 只保留接入默认 `apiKey`，因此未加载扩展时仍能按默认 key 工作。

## 模型元数据同步规则

保存模型时：

1. 选择 `models.dev`、OpenRouter 或手工模式。
2. `models.dev` 仅按 Model ID 匹配远程数据（搜索全部供应商），不依赖 Provider 名称，便于第三方 API 接入。
3. OpenRouter 使用完整模型 ID（例如 `openai/gpt-5.4`）匹配远程数据。
4. 成功匹配后更新模型能力、上下文、输出上限、推理映射和价格。
5. OpenRouter 的 token 单价会转换为每百万 token 价格，以适配 Pi 的 `models.json` 格式。
6. 远程字段缺失时保留现有 context / maxTokens；手工模式不发起网络请求。

## 不同于上游的兼容约束

- `models.json` 仍是模型配置的唯一权威来源；扩展不会另建一套模型运行时数据库。
- 未被扩展明确接管的原生 Provider 不会被自动注册、改写或删除。
- 扩展要求 Pi `>=0.85.1`，并依赖 `@earendil-works/pi-ai >=0.85.1`、`@earendil-works/pi-tui >=0.75.0`。

## 上游同步原则

同步上游 Pi 时：

1. 先确认上游 API、配置 schema 没有不兼容变化。
2. 保留本项目的 TUI、模型元数据同步和配置事务代码。
3. 不要把真实的 `models.json`、`state.json`、API key 或请求抓包数据加入 Git。
4. 运行完整测试：

   ```bash
   npm test
   ```

5. 如果上游改变配置路径或模型字段，先更新本文和 README，再更新实现与测试。
