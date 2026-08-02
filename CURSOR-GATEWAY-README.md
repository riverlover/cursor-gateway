# Cursor Token 网关 (Cursor Gateway) - 完整技术文档

> 创建时间: 2026-08-02  
> Token 邮箱: `deborahreeves4006@outlook.com`  
> 代理端口: `4647`  
> 仅用于技术机制分析

---

## 一、核心结论

### 1.1 Cursor IDE 双重认证架构

Cursor IDE 使用**两条独立的认证通道**：

| 通道 | 域名 | 认证方式 | 用途 |
|------|------|----------|------|
| **REST API** | `https://cursor.com` | Cookie (`WorkosCursorSessionToken`) + Bearer Token | 前端 Web API、账号管理、用量查询 |
| **gRPC API** | `https://api2.cursor.sh` | `@connectrpc/connect` 拦截器 + Bearer Token | 后端 gRPC 服务、聊天补全 |

### 1.2 三种独立认证系统 (互不兼容)

| 系统 | 认证方式 | Token 存储 | 用途 |
|------|----------|------------|------|
| **Auth0 Web** | OAuth JWT | `state.vscdb` → `cursorAuth/accessToken` | IDE 前端登录 |
| **Cursor API Key** | 官方 API Key | 环境变量 `CURSOR_API_KEY` | 开发者 API 调用 |
| **Agent OAuth** | `agent login` OAuth | 独立凭证存储 | Agent CLI 子进程 |

**关键发现**: 三种认证系统**完全不互通**，JWT 不能注入到 Agent CLI，API Key 不能用于 gRPC 拦截器。

### 1.3 JWT Token 提取与 Web Token 推导

```bash
# 从 state.vscdb 提取 JWT
sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
  "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';"
```

**Web Token 推导公式**:
```
JWT sub:     auth0|user_01KSVN7E6B06B8G1BXPT9Q8REG
                            ↓ 取 | 后面的部分
UID:         user_01KSVN7E6B06B8G1BXPT9Q8REG
                            ↓ 拼接格式
WEB_TOKEN:   user_01KSVN7E6B06B8G1BXPT9Q8REG::JWT
                            ↓ 作为 Cookie
Cookie:      WorkosCursorSessionToken=WEB_TOKEN
```

---

## 二、Cursor Gateway 代理架构

### 2.1 整体架构

```
┌─────────────────────────────────────────────────────┐
│               Cursor Gateway (Port 4647)            │
│                                                      │
│  GET  /health         → Token 验证 + CLI 状态       │
│  GET  /api/usage      → DashboardClient (JWT → API) │
│  GET  /v1/models      → 动态 + 静态模型列表         │
│  POST /v1/chat/completions → CursorSubprocess (CLI) │
│                                                      │
└─────────────────────────────────────────────────────┘
         │                              │
         ▼                              ▼
┌──────────────────┐         ┌──────────────────────┐
│ api2.cursor.sh   │         │ agent CLI subprocess │
│ (HTTP/JSON + JWT)│         │ (OAuth auth)         │
│ DashboardService │         │ -p --stream-json     │
└──────────────────┘         └──────────────────────┘
```

### 2.2 双路径设计

| 端点 | 认证方式 | 传输协议 | 实现 |
|------|----------|----------|------|
| `/api/usage` | JWT Bearer | HTTP/JSON | 直接调用 `api2.cursor.sh` |
| `/v1/chat/completions` | Agent OAuth | 子进程 stdin/stdout | 调用本地 `cursor-agent` CLI |

### 2.3 项目结构

```
~/Downloads/cursor-gateway/
├── package.json          # 项目配置
├── tsconfig.json         # TypeScript 配置
└── src/
    ├── index.ts          # 主入口 (Express 服务)
    ├── types/
    │   └── index.ts      # API 类型定义
    ├── client/
    │   ├── dashboard.ts  # DashboardClient (JWT HTTP/JSON)
    │   └── subprocess.ts # CursorSubprocess (CLI 子进程)
    ├── adapter/
    │   ├── openai-to-cli.ts   # OpenAI → CLI prompt 转换
    │   └── cli-to-openai.ts   # CLI output → OpenAI 响应
    └── api/
        └── routes.ts     # Express 路由处理器
```

---

## 三、快速开始

### 3.1 安装依赖

```bash
cd ~/Downloads/cursor-gateway
source ~/.nvm/nvm.sh && nvm use 20
npm install
```

### 3.2 环境变量

```bash
# 必需: JWT Token (从 state.vscdb 提取)
export CURSOR_JWT="<your-jwt-from-state.vscdb>"

# 可选: Agent CLI 路径 (默认自动检测)
export CURSOR_AGENT_BIN="/Users/lizhenhe/.local/share/cursor-agent/versions/2026.07.23-e383d2b/cursor-agent"

# 可选: 端口 (默认 4647)
export PORT=4647
```

### 3.3 启动服务

```bash
npx tsx src/index.ts
```

**预期输出**:
```
[CursorGateway] Using agent CLI: /Users/lizhenhe/.local/share/cursor-agent/versions/2026.07.23-e383d2b/cursor-agent
✅ Cursor Gateway running on http://localhost:4647
   /health          - Health check + token validation
   /api/usage       - Cursor account usage (JWT auth)
   /v1/models       - Available models (OpenAI-compatible)
   /v1/chat/completions - Chat completions (OpenAI-compatible)
```

---

## 四、API 端点说明

### 4.1 GET /health - 健康检查

**功能**: 验证 JWT Token 和 Agent CLI 状态

```bash
curl -s http://localhost:4647/health | python3 -m json.tool
```

**返回示例**:
```json
{
  "status": "healthy",
  "provider": "cursor-gateway",
  "port": 4647,
  "timestamp": "2026-08-02T02:16:47.292Z",
  "cursor_token_valid": true,
  "token_email": "token decoded",
  "agent_cli_status": "connected",
  "cli_version": "2026.07.23-e383d2b"
}
```

### 4.2 GET /api/usage - 账号用量

**功能**: 通过 JWT 从 `api2.cursor.sh` 查询账号使用量

```bash
curl -s http://localhost:4647/api/usage | python3 -m json.tool
```

**支持刷新**: `?refresh=1` 强制刷新缓存

**返回示例**:
```json
{
  "billingCycleStart": "1785388866023",
  "billingCycleEnd": "1788067266023",
  "planUsage": {
    "totalSpend": 39,
    "bonusSpend": 39,
    "autoPercentUsed": 39,
    "apiPercentUsed": 0,
    "totalPercentUsed": 19.5
  },
  "autoBucketModels": [
    "default", "composer-1.5", "composer-2", "composer-2.5",
    "vega", "vega-medium", "vega-high", "vega-xhigh",
    "grok-4.5", "cursor-grok-4.5-low", "cursor-grok-4.5-high"
  ]
}
```

### 4.3 GET /v1/models - 模型列表

**功能**: 返回 OpenAI 兼容的模型列表

```bash
curl -s http://localhost:4647/v1/models | python3 -m json.tool | head -20
```

**模型来源**:
- 动态获取: `autoBucketModels` 从 Dashboard API
- 静态列表: 已知 Cursor 支持的所有模型

**总模型数**: 53 个 (包含 all Cursor 支持的模型)

### 4.4 POST /v1/chat/completions - 对话补全

**功能**: OpenAI 兼容的聊天补全接口

#### 非流式响应

```bash
curl -s http://localhost:4647/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Say hello in 5 words"}
    ]
  }'
```

**返回示例**:
```json
{
  "id": "chatcmpl-bc5f1e5c60ec48f0b8566bc0",
  "object": "chat.completion",
  "created": 1785637030,
  "model": "Auto",
  "choices": [{
    "index": 0,
    "message": {
      "role": "assistant",
      "content": "Hello there, friend — welcome aboard!"
    },
    "finish_reason": "stop"
  }],
  "usage": {
    "prompt_tokens": 0,
    "completion_tokens": 0,
    "total_tokens": 0
  }
}
```

#### 流式响应 (SSE)

```bash
curl -s http://localhost:4647/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "user", "content": "Count to 3"}
    ],
    "stream": true
  }'
```

**返回示例**:
```
data: {"id":"chatcmpl-37a2df7069d04c4c9442cb44","object":"chat.completion.chunk","created":1785637051,"model":"auto","choices":[{"index":0,"delta":{"role":"assistant","content":"1 \n2 \n3"},"finish_reason":null}]}

data: {"id":"chatcmpl-37a2df7069d04c4c9442cb44","object":"chat.completion.chunk","created":1785637051,"model":"Auto","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}

data: [DONE]
```

---

## 五、与其他工具集成

### 5.1 ZCode 配置

| 字段 | 值 |
|------|-----|
| Base URL | `http://localhost:4647/v1` |
| API 格式 | `Chat Completions (/chat/completions)` |
| API Key | `not-needed` |
| 模型 | `auto` |

### 5.2 cURL 测试

```bash
curl http://localhost:4647/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer not-needed" \
  -d '{
    "model": "auto",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant"},
      {"role": "user", "content": "你好，请介绍你自己"}
    ]
  }'
```

### 5.3 Python 集成

```python
import requests

response = requests.post(
    "http://localhost:4647/v1/chat/completions",
    json={
        "model": "auto",
        "messages": [
            {"role": "user", "content": "Hello"}
        ]
    },
    headers={
        "Authorization": "Bearer not-needed"
    }
)

print(response.json()["choices"][0]["message"]["content"])
```

---

## 六、技术实现细节

### 6.1 JWT HTTP/JSON 调用流程

```
JWT Token (Auth0)
    ↓
DashboardClient.getUsage()
    ↓
POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage
Headers:
  - Content-Type: application/json
  - Authorization: Bearer <JWT>
    ↓
JSON Response (CursorUsageResponse)
```

**验证**: 该端点直接支持 `application/json`，无需 gRPC-Web 协议。

### 6.2 Agent CLI 子进程调用流程

```
Chat Completion Request
    ↓
openaiToCli() → CLI Prompt String
    ↓
spawn(AGENT_BIN, args, {stdio: ["pipe", "pipe", "pipe"]})
  AGENT_BIN: /path/to/cursor-agent
  args: -p --output-format stream-json --stream-partial-output --yolo
    ↓
stdin: prompt text
stdout: JSON events (system, assistant, tool_call, result)
    ↓
processBuffer() → handleMessage()
    ↓
Events:
  - content_delta: { text: "partial..." }
  - result: { text: "full response", model: "Auto" }
    ↓
cliToOpenai() → OpenAI Response Format
```

### 6.3 Agent CLI 路径检测

```typescript
function findAgentCli(): string {
  const paths = [
    process.env.CURSOR_AGENT_BIN,      // 1. 环境变量
    "/Users/lizhenhe/.local/share/...", // 2. 默认路径
    "agent",                            // 3. PATH 中查找
  ];
  // 返回第一个存在的路径
}
```

### 6.4 核心源码文件

#### `src/client/dashboard.ts` - Dashboard API 客户端

```typescript
export class DashboardClient {
  async getUsage(): Promise<CursorUsageResponse> {
    const response = await fetch(
      `${CURSOR_API_BASE}/aiserver.v1.DashboardService/GetCurrentPeriodUsage`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.jwtToken}`,
        },
        body: JSON.stringify({}),
      }
    );
    return response.json();
  }
}
```

#### `src/adapter/openai-to-cli.ts` - OpenAI → CLI 转换

```typescript
export function openaiToCli(request: ChatCompletionRequest): CliInput {
  // 1. 提取 prompt 文本
  // 2. 多轮对话添加 [System]/[User]/[Assistant] 前缀
  // 3. 归一化模型名称
  return {
    prompt: messagesToPrompt(request.messages),
    model: extractModel(request.model || "auto"),
  };
}
```

#### `src/api/routes.ts` - 路由处理器

```typescript
export async function handleChatCompletions(req, res, dashboardClient) {
  const { prompt, model } = openaiToCli(req.body);
  const subprocess = new CursorSubprocess();
  
  // 流式响应处理
  subprocess.on("content_delta", (delta) => {
    res.write(`data: ${JSON.stringify(createStreamChunk(...))}\n\n`);
  });
  
  subprocess.on("result", (result) => {
    res.write("data: [DONE]\n\n");
    res.end();
  });
  
  subprocess.start(prompt, { model, apiKey });
}
```

---

## 七、已知限制与注意事项

### 7.1 认证分离

- JWT Token 仅用于 Dashboard API (用量查询)
- Chat 补全需要 Agent CLI 独立 OAuth 登录 (`agent login`)
- 两种认证系统**完全独立**，不能互换

### 7.2 模型支持

- `/v1/models` 返回 53 个模型 (包含所有已知 Cursor 模型)
- 实际可用模型取决于账号等级和套餐
- `auto` 模式自动选择最佳模型

### 7.3 Agent CLI 依赖

- 需要 Cursor IDE 已安装 (`cursor-agent` 脚本)
- Agent CLI 需要独立登录 (`agent whoami` 验证)
- 超时时间: 5 分钟 (300,000ms)

### 7.4 安全提醒

1. **Token 已暴露于对话中** — 建议重新登录刷新
2. **仅监听 localhost** — 不暴露公网
3. **JWT Token 有效期** — 检查 `exp` 字段
4. **Agent CLI 认证** — 与 JWT 不同账户 (lizhenhe77@gmail.com)

---

## 八、故障排查

### 8.1 端口被占用

```bash
lsof -i:4647         # 查看占用进程
kill -9 <PID>        # 强制终止
```

### 8.2 Agent CLI 未找到

```bash
# 检查路径
ls -la /Users/lizhenhe/.local/share/cursor-agent/versions/2026.07.23-e383d2b/cursor-agent

# 验证版本
/Users/lizhenhe/.local/share/cursor-agent/versions/2026.07.23-e383d2b/cursor-agent --version

# 检查登录状态
agent whoami
```

### 8.3 JWT Token 无效

```bash
# 检查 Token 格式
echo "<JWT>" | cut -d. -f2 | base64 -d | python3 -m json.tool

# 检查过期时间
# exp 字段应为未来时间戳
```

### 8.4 服务日志

```bash
# 实时查看输出
npx tsx src/index.ts 2>&1 | tee gateway.log
```

---

## 九、核心步骤总结

### 步骤 1: 提取 JWT Token

```bash
sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
  "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';"
```

### 步骤 2: 启动 Cursor Gateway

```bash
cd ~/Downloads/cursor-gateway
export CURSOR_JWT="<token>"
npx tsx src/index.ts
```

### 步骤 3: 验证端点

```bash
curl http://localhost:4647/health                    # 健康检查
curl http://localhost:4647/api/usage                 # 用量查询
curl http://localhost:4647/v1/models                 # 模型列表
curl -X POST http://localhost:4647/v1/chat/completions \  # 对话补全
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"hello"}]}'
```

### 步骤 4: 集成到 ZCode/Opencode

```bash
# 设置环境变量
export OPENAI_API_BASE=http://localhost:4647/v1
export OPENAI_API_KEY=not-needed
```

---

## 十、架构优势

| 特性 | 说明 |
|------|------|
| **OpenAI 兼容** | 直接兼容所有 OpenAI 客户端库 |
| **双路径设计** | JWT + CLI 双通道，充分利用两种认证 |
| **动态模型列表** | 从 Dashboard API 获取可用模型 |
| **流式响应** | SSE 协议，支持实时输出 |
| **自动路径检测** | 自动查找 agent CLI 位置 |
| **零依赖部署** | 仅需 Node.js 18+ |

---

*本文档仅用于技术机制分析，请勿用于非法用途*
