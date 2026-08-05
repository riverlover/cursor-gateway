# Cursor Gateway

OpenAI-compatible proxy for Cursor. Exposes chat completions and account usage over HTTP, backed by Cursor’s JWT (Dashboard API) and a warm local `cursor-agent` CLI pool.

Also includes a tiny floating **Usage HUD** for Windows and macOS that reads the live Cursor session and polls official usage APIs.

## Features

- **OpenAI-compatible API** — `/v1/chat/completions`, `/v1/models`
- **Usage endpoint** — `/api/usage` via JWT → `api2.cursor.sh`
- **Warm agent pool** — pre-spawned `agent` workers for lower first-token latency
- **Streaming (SSE)** and non-streaming chat completions
- **Usage HUD** — always-on-top overlay showing plan, email, and remaining usage

## Architecture

```
Clients (OpenAI SDKs, curl, etc.)
        │
        ▼
┌───────────────────────────────────────┐
│         Cursor Gateway (:4647)        │
│                                       │
│  GET  /health                         │
│  GET  /api/usage      ──JWT──► api2   │
│  GET  /v1/models      ──JWT──► api2   │
│  POST /v1/chat/completions            │
│         │                             │
│         └──► warm AgentPool (CLI)     │
└───────────────────────────────────────┘
```

Two auth paths (they are not interchangeable):

| Path | Auth | Used for |
|------|------|----------|
| Dashboard HTTP/JSON | `CURSOR_JWT` (Auth0 access token) | `/api/usage`, `/v1/models`, health |
| Agent CLI | `agent login` OAuth | `/v1/chat/completions` |

## Requirements

- Node.js 18+
- Cursor Agent CLI installed and logged in (`agent whoami`)
- A Cursor IDE JWT for usage/models (from `state.vscdb`)

## Quick start

```bash
npm install

# Extract JWT (macOS)
sqlite3 ~/Library/Application\ Support/Cursor/User/globalStorage/state.vscdb \
  "SELECT value FROM ItemTable WHERE key = 'cursorAuth/accessToken';"

export CURSOR_JWT="<your-jwt>"
npm run dev
```

Gateway listens on `http://localhost:4647` by default.

```bash
# Health
curl -s http://localhost:4647/health | jq .

# Usage
curl -s http://localhost:4647/api/usage | jq .

# Chat (non-stream)
curl -s http://localhost:4647/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","messages":[{"role":"user","content":"Say hello in 5 words"}]}'

# Chat (SSE stream)
curl -sN http://localhost:4647/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"Count to 3"}]}'
```

### Use as an OpenAI base URL

| Setting | Value |
|---------|-------|
| Base URL | `http://localhost:4647/v1` |
| API Key | `not-needed` (or any non-empty string) |
| Model | `auto` (or any model from `/v1/models`) |

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CURSOR_JWT` | *(required)* | Auth0 JWT from Cursor `state.vscdb` |
| `PORT` | `4647` | HTTP listen port |
| `CURSOR_AGENT_BIN` | auto-detect | Path to `cursor-agent` / `agent` binary |
| `AGENT_MODE` | `ask` | CLI mode passed to agent workers |
| `AGENT_POOL_SIZE` | `1` | Number of warm workers |
| `AGENT_ACQUIRE_TIMEOUT_MS` | `60000` | Max wait when borrowing a worker |
| `AGENT_WARM_MODEL` | `auto` | Model used when warming idle workers |

## Project layout

```
├── src/
│   ├── index.ts                 # Express entry
│   ├── api/routes.ts            # Handlers
│   ├── adapter/                 # OpenAI ↔ CLI converters
│   ├── client/
│   │   ├── dashboard.ts         # JWT → api2.cursor.sh
│   │   ├── subprocess.ts        # Single agent CLI process
│   │   └── agent-pool.ts        # Warm process pool
│   └── types/
├── hud/
│   ├── Program.cs               # Windows WinForms HUD
│   ├── build.ps1
│   └── macos/                   # Native AppKit HUD
│       ├── Package.swift
│       ├── Sources/main.swift
│       └── build.sh
└── scripts/
    └── get-cursor-usage.ps1
```

## Usage HUD

Floating overlay that reads the live Cursor session DB and refreshes usage about every 60s. Shows email, plan, and remaining usage percent.

### macOS

Requires macOS 13+, Xcode CLT / Swift 5.9+.

```bash
cd hud/macos
./build.sh

# App (menu-bar style, no Dock icon)
open CursorUsageHud.app

# One-shot CLI dump
./CursorUsageHud --once
```

### Windows

Requires .NET (WinForms).

```powershell
cd hud
.\build.ps1
# Run the produced CursorUsageHud.exe
```

## Scripts

```bash
npm run dev      # tsx, no build step
npm run build    # tsc → dist/
npm start        # node dist/index.js
```

## Notes

- JWT and Agent CLI logins are **separate**. Refresh usage with a valid `CURSOR_JWT`; chat needs a logged-in agent CLI.
- Prefer binding to localhost only; do not expose the gateway publicly with your session token.
- For a deeper dive into Cursor’s dual auth model and internals, see [`CURSOR-GATEWAY-README.md`](./CURSOR-GATEWAY-README.md).

## License

MIT
