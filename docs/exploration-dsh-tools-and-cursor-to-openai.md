# 探索笔记：接 dsh / OpenAI tools，以及 Cursor-To-OpenAI 试跑

> 日期：2026-08-31  
> 状态：探索未打通 dsh 级 tool calling；过程与结论保留备查  
> 相关：本仓 `cursor-gateway`、本机 clone `d:\vscode\Cursor-To-OpenAI`（JiuZ-Chn）

---

## 1. 目标回顾

评估能否把 Cursor 能力代理成 **OpenAI Compatible** 接口（SK 可随意，如 `no-key`），并接到 **DeepSeek Harness（dsh）** 等自带工具环的 agent。

本仓已具备：

- `POST /v1/chat/completions`、`GET /v1/models`、SSE
- 客户端 SK **不校验**（`no-key` / `not-needed` 等占位符忽略）
- Chat 走本地 `cursor-agent` CLI；用量/模型走 `CURSOR_JWT` → `api2.cursor.sh`

---

## 2. 重要结论（摘要）

### 2.1 本仓对 dsh：协议能接，agent 工具环不够

| dsh 需要 | 本仓现状 |
|----------|----------|
| `api: openai-completions` + `baseURL .../v1` | 已对齐 |
| SK 任意非空 | 已支持 |
| 请求带 `tools[]`，响应 `tool_calls` + `finish_reason: tool_calls` | **未实现** |
| 多轮 `role: tool` | **未正确处理** |

dsh（`llm-pi-ai`）工具由 **客户端本地执行**；模型 API 只需输出结构化调用意图。本仓只转发 CLI 文本并固定 `finish_reason: stop`，对 dsh 只能当聊天模型，不能当工具大脑。

### 2.2 难点在接入层，不在 SSE

```
理想：dsh ──tools──► 裸 Chat API ──tool_calls──► dsh 执行本地工具

本仓：dsh ──► Gateway ──► cursor-agent CLI（已是 Agent 产品层）
```

- **Tools = 客户端本地能力**；**tool_calls = 模型/API 的一种回复类型**。
- SSE 只是流式传输，不是 tool calling 的前提。
- 接在 CLI 层 = 在 Cursor Agent「包一层之后」拦截：CLI 的 `tool_call` 是 Cursor 自有工具，不是 dsh 的 `tools[]`；忽略 `tools` 再拼 prompt 只能做有损 prompt 桥。

### 2.3 「更上一层」存在，但不等于任意 OpenAI tools

| 层级 | 入口 | 说明 |
|------|------|------|
| 本仓 | `cursor-agent` CLI | 官方通道，稳；无原生 OpenAI function calling |
| 逆向 | `api2` `ChatService/StreamUnifiedChatWithTools` | 更靠近模型侧；工具多为 Cursor 固定枚举 |
| 官方 SDK | `@cursor/sdk` Agent | 仍是 Agent 运行时，不是裸 Chat + tools |
| 真模型 API | OpenAI/Anthropic… | 原生 tools；不再是「代理 Cursor 额度」 |

### 2.4 本地 Agent 如何通过验证（与反代对比）

官方 CLI 鉴权（[文档](https://cursor.com/docs/cli/reference/authentication)）只有：

1. **`agent login`**（浏览器 OAuth）→ CLI **独立本地凭证**（≠ `state.vscdb` JWT）
2. **`CURSOR_API_KEY` / `--api-key`**（Dashboard API Keys）

`agent whoami` / `agent status` 查登录态。

三条认证 **不互通**：

| 通道 | 凭证 | 用途 |
|------|------|------|
| IDE / Auth0 JWT | `state.vscdb` → `cursorAuth/accessToken` | 本仓用量、部分 Dashboard |
| Agent OAuth | `agent login` | 本仓 chat（CLI 子进程） |
| 官方 API Key | `CURSOR_API_KEY` | CLI/SDK/CI |

**本地 agent 能过关，是因为官方二进制自带当前客户端版本与协议**，走的是官方通道；不是「任意 Node 反代 + 抠出的 JWT + 自造 checksum」。

### 2.5 Cursor-To-OpenAI 试跑（失败但有信息量）

- 仓库：`https://github.com/JiuZ-Chn/Cursor-To-OpenAI`（MIT），clone 至 `d:\vscode\Cursor-To-OpenAI`
- **不需要密码**：Bearer 用 IDE JWT 即可（本机从 `state.vscdb` 提取）
- `GET /v1/models`：**HTTP 200**（JWT 有效）
- `POST /v1/chat/completions`：
  - `default` / `composer-2.5` → 上游 **Update Required**（客户端版本/协议不被支持），代理仍回 200 但 `content` 为空
  - `auto` → **`ERROR_BAD_MODEL_NAME`**：`auto` 在该路径 **不是合法模型名**（列表里是 `default` 等）
- 本机将 `CURSOR_CLIENT_VERSION` 提到与 IDE 一致的 `3.14.7` 后，Update Required **仍在** → 不只是版本字符串，协议/指纹整体偏旧
- 本环境 `npm start` 会因 spawn `cmd.exe` `EACCES` 失败，需直接 `node src/app.js`

**结论**：token-only 够鉴权到 AvailableModels；chat 被服务端拒绝证明「接 api2 逆向层」脆弱。要稳仍应用官方 CLI/SDK。

---

## 3. tool_calls 与普通文本的本质区别（备忘）

| | 文本 response | tool_calls response |
|--|--|--|
| 语义 | 答案在 `content`，本轮结束 | 挂起：请客户端按 name/arguments 执行工具后再喂回 |
| `finish_reason` | `stop` / `length` | **`tool_calls`** |
| 下一轮 | 用户新消息 | 必须带 `role: "tool"`（`tool_call_id`） |
| 谁执行工具 | 无 | **客户端**（dsh），不是模型 |

后端要具备：理解 `tools`、产出结构化 `tool_calls`、吃 tool 结果、用 `finish_reason` 区分未完成/已完成。不必自己执行 bash。

本仓若强行接 dsh：可在适配器做 **prompt 桥**（有损）；或换支持 function calling 的上游。**不要**对 dsh 开 `AGENT_MODE=agent`（双工具环）。

---

### 2.6 cursor2api 试跑（[7836246/cursor2api](https://github.com/7836246/cursor2api)）

- Clone：`d:\vscode\cursor2api`（v2.7.8，MIT）
- **接入点不同**：代理的是 **Cursor 文档站免费对话** `https://cursor.com/api/chat`，不是 `api2` IDE Chat，也不是 Agent CLI
- README 已标注：`20260401 Cursor文档页仅剩 gemini-3-flash（凉）`
- 对外鉴权：本机 `auth` 设为 open 时可无 SK；上游可选 `CURSOR_COOKIE`（关键多为 `_vcrcs` Vercel 挑战），**不是**本仓那种「必须 CURSOR_JWT」模型
- 启动：`PORT=3012`，`node --import tsx src/index.ts`（本环境 `npx`/`npm` script 会 `EACCES`）
- `GET /v1/models`：**HTTP 200**（本地静态列表，含 `google/gemini-3-flash` 等）
- `POST /v1/chat/completions`：**HTTP 500** — 上游返回 Next.js「This page couldn’t load」HTML  
  - 无 cookie 与带 IDE JWT 拼的 `WorkosCursorSessionToken` 均失败  
  - 未再起 stealth-proxy（需 Playwright Chromium，成本高且文档 API 本身可能已废）

**结论**：cursor2api 对 dsh  theoretically 更友好（自带工具桥接/截断续写等），但 **当前上游 docs `/api/chat` 不可用**；有 token 不够，缺的是活的免费文档 API（或可用的 `_vcrcs` + stealth，仍取决于上游是否还开着）。与 Cursor-To-OpenAI、本仓 CLI 是 **三条不同上游**。

---

## 4. 实用建议

1. **接 ZCode / 只聊天**：本仓 `BASE_URL=http://localhost:4647/v1`，`API_KEY=no-key`，够用。  
2. **接 dsh 当编码 agent**：当前不够；需 tool_calls 桥或换上游；Cursor-To-OpenAI / cursor2api 现状都不能当生产后端。  
3. **本机 Windows**：确认 `agent` 在 PATH 且 `agent whoami` 通过，本仓 chat 才有真实后端。  
4. **合规**：逆向 api2 / 文档免费 API 均有风控与 ToS 风险；优先官方 CLI / API Key / SDK。

---

## 5. 未完成 / 后续可选

- [ ] 本仓实现 OpenAI `tools` / `tool_calls` prompt 桥（ask 模式）并做 dsh 联调  
- [ ] 跟踪更新的 Cursor-To-OpenAI / patched fork 协议是否恢复 chat  
- [ ] 若文档 API 恢复：再试 cursor2api + stealth-proxy（`_vcrcs`）  
- [ ] 评估官方 `@cursor/sdk` 是否满足「代理」以外的自动化场景（仍非裸 tools API）

---

*本文记录探索过程；失败结论与成功路径同等重要。*
