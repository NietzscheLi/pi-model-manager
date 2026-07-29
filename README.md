# pi-model-manager

[English](./README.en.md) · 简体中文

[![Pi](https://img.shields.io/badge/Pi-%3E%3D0.82.0-6f42c1)](https://github.com/earendil-works/pi)
[![License](https://img.shields.io/badge/license-AGPL--3.0-blue.svg)](./LICENSE)
[![Version](https://img.shields.io/badge/version-0.2.0-2f81f7.svg)](https://github.com/Qihuanxishini/pi-model-manager)

一个面向 [Pi](https://github.com/earendil-works/pi) 的 TUI 模型与接入管理扩展。它以 Pi 原生 `models.json` 为模型配置的唯一权威来源，并提供接入/模型编辑、请求头身份、代理路由和协议兼容配置。

> 当前稳定版为 `0.2.0`，要求 Pi `>=0.82.0`。

## 界面预览

![pi-model-manager 界面总览](https://raw.githubusercontent.com/Qihuanxishini/pi-model-manager/main/assets/pi-model-manager-preview.png)

<details>
<summary>查看四张完整截图</summary>

### 接入配置

![接入配置](https://raw.githubusercontent.com/Qihuanxishini/pi-model-manager/main/assets/screenshots/provider-setup.png)

### 模型发现

![模型发现](https://raw.githubusercontent.com/Qihuanxishini/pi-model-manager/main/assets/screenshots/model-discovery.png)

### 接入与模型总览

![接入与模型总览](https://raw.githubusercontent.com/Qihuanxishini/pi-model-manager/main/assets/screenshots/provider-models.png)

### 模型能力

![模型能力](https://raw.githubusercontent.com/Qihuanxishini/pi-model-manager/main/assets/screenshots/model-editor.png)

</details>
## 功能

- 在 `/model-manager` TUI 中新增、编辑和删除接入与模型。
- 原生支持 `openai-completions`、`openai-responses`、`anthropic-messages` 和 `google-generative-ai`。
- 从兼容上游拉取模型 ID，也可手动填写模型。
- 配置上下文窗口、最大输出、视觉输入和 Thinking。
- 支持 Anthropic Adaptive Thinking 与 Legacy Thinking。
- 可为 OpenAI Responses 模型启用 `service_tier=priority`（Fast mode）。
- 为每个接入单独配置直连或 HTTP(S) 代理。
- 提供自动推荐、禁用、Claude Code、Codex 和自定义请求头模式。
- API key 支持字面值、`$ENV_VAR` / `${ENV_VAR}` 和 Pi 的 `!command` 引用。
- 使用跨进程锁与可恢复双文件事务持久化配置，并在保存后重新注册受管理的 Provider。

## 安装

### 从 GitHub 安装（当前推荐）

```bash
pi install git:github.com/Qihuanxishini/pi-model-manager
```

也可以先临时试用，不写入 Pi 的包配置：

```bash
pi -e git:github.com/Qihuanxishini/pi-model-manager
```

更新 Git 安装的扩展：

```bash
pi update --extensions
```

### 从 npm 安装

`pi-model-manager` 已发布为公开 npm 包：

```bash
pi install npm:pi-model-manager
```

## 快速开始

1. 启动 Pi TUI。
2. 执行：

   ```text
   /model-manager
   ```

3. 在主面板中管理接入：

   | 按键 | 操作 |
   | --- | --- |
   | `Enter` | 进入所选接入并管理模型 |
   | `n` | 新建接入及其第一个模型 |
   | `d` | 删除所选接入 |
   | `h` | 管理可复用请求头 |
   | `/` | 搜索当前列表 |
   | `Esc` | 返回或退出 |

4. 在编辑器中使用方向键选择字段，按 `Enter` 编辑；支持切换的字段可用 `←` / `→` 调整；按 `Ctrl+S` 保存。

保存会更新并启用模型，但不会强制切换当前会话正在使用的模型。

## 配置模型

### 接入配置

每个接入可以配置：

- API 协议与 Base URL
- API key 与认证头行为
- 请求头身份
- 接入级 HTTP(S) 代理
- 一个或多个模型

新建模型时，扩展会尝试从上游读取模型列表；整次发现（包括认证回退）共用一个 10 秒上限，可按 `Esc` 手动取消。失败或取消后仍可手动输入模型 ID。

### 模型能力

模型编辑器支持：

- 显示名称
- 文本或文本+图像输入
- Thinking 开关
- Anthropic Adaptive/Legacy Thinking 协议
- OpenAI Responses Fast mode
- Context window 与最大输出 token

## 请求头模式

| 模式 | 行为 |
| --- | --- |
| 自动推荐 | Anthropic Messages 使用 Claude Code；OpenAI Completions/Responses 使用 Codex；其他协议不附加身份头 |
| 不添加 | 不添加扩展管理的客户端身份请求头 |
| Claude Code | 使用内置 Claude Code 兼容请求头，并为 Anthropic 请求补充必要的兼容 metadata |
| Codex | 使用内置 Codex TUI 兼容请求头 |
| 自定义 | 使用在请求头面板中创建的可复用 JSON 请求头集合 |

当前内置值来自真实客户端请求并已移除认证信息：

- Claude Code `2.1.219`
- Codex TUI `0.145.0`

这些值只用于兼容需要识别客户端身份的 API 中转，不代替 API key。公开仓库和 npm 包**不包含请求捕获工具、用户抓包、认证头或本机状态**。如果内置值不适合你的服务，请关闭身份头或创建自定义请求头。

自定义请求头会拒绝认证类敏感字段；认证信息应放在接入的 API key 配置中。

## 配置文件

| 路径 | 用途 |
| --- | --- |
| `~/.pi/agent/models.json` | Pi 原生接入与模型定义；模型配置的唯一权威来源 |
| `~/.pi/agent/extensions/pi-model-manager/state.json` | 请求头选择、自定义请求头、代理开关和 Fast mode 等扩展私有元数据 |

扩展只会为明确受管理的 Provider 生成请求头、代理路由和动态注册配置。所有权由 `state.json` 的受管理 ID 与 `models.json` Provider 节点中的 `piModelManager.managed` 标记共同确认，防止已删除的 Provider ID 在日后被同名原生配置复用时遭到插件接管。没有这些所有权信息的原生 Provider 保持未管理，其已有 Header 和未知原生字段不会因保存其它配置而被改写；Pi 内置 Provider 不在本扩展中提供编辑或删除入口。

插件自身的配置写入由跨进程锁串行化，`enabledModels` 还同时遵守 Pi 的 `proper-lockfile` 锁；`models.json` 与 `state.json` 通过事务意图文件在中断后恢复，读取方不会采用事务进行中的半完成组合。外部编辑器不受这些锁约束，因此保存前仍会校验内容签名；检测到外部修改时会取消保存而不是覆盖。

## 密钥与安全

Pi 扩展以当前用户权限运行并拥有完整系统访问能力。安装任何第三方扩展前都应审阅源码。

推荐通过环境变量或命令引用 API key，避免把密钥明文写入 `models.json`：

```text
$OPENAI_API_KEY
${ANTHROPIC_API_KEY}
!your-secret-command
```

其他注意事项：

- 自定义请求头不是保存认证凭据的位置。
- 启用接入代理后，该接入的请求会经过你填写的代理地址。
- 拉取模型列表会向所配置的上游地址发起网络请求。
- 仓库忽略 `state.json`、运行日志、请求捕获数据和其他机器专属文件。

## 兼容性

| 组件 | 要求 |
| --- | --- |
| `@earendil-works/pi-coding-agent` | `>=0.82.0` |
| `@earendil-works/pi-tui` | `>=0.75.0` |
| 运行模式 | `/model-manager` 需要 Pi TUI |

当前 TUI 文案为简体中文。

## 本地开发

```bash
git clone https://github.com/Qihuanxishini/pi-model-manager.git
cd pi-model-manager
npm install
pi -e .
```

扩展由 Pi 直接加载 TypeScript 入口，不需要单独构建步骤。开发时请勿提交 `state.json`、`bootstrap-meta.json`、`node_modules` 或任何请求捕获数据。

验证公开包内容：

```bash
npm pack --dry-run
```

## 问题反馈

请通过 [GitHub Issues](https://github.com/Qihuanxishini/pi-model-manager/issues) 提交可复现的问题。报告配置问题时，请删除 API key、认证头、代理凭据和私有 endpoint。

## 致谢

感谢 [LINUX DO](https://linux.do/) 社区的讨论、分享和反馈。

## 许可证

本项目采用 [GNU Affero General Public License v3.0 only](./LICENSE)。分发修改版本时必须公开对应源码、继续使用 AGPL-3.0，并明确标注改动；修改版不得冒充官方发行。详见 [NOTICE](./NOTICE)。
