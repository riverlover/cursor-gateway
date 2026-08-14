# Cursor Usage HUD — 可复现提示词

把下面整段提示词丢给 AI，即可在任意平台复刻同款「Cursor 用量浮动窗」程序。实现细节以本仓库 `hud/Program.cs`（Windows）与 `hud/macos/Sources/main.swift`（macOS）为准。

---

## 一键提示词（复制即用）

```text
请实现一个名为 Cursor Usage HUD 的桌面小工具，要求如下。

## 目标
做一个始终置顶的浮动小窗，读取本机 Cursor IDE 登录态，调用官方用量 API，
显示当前账号邮箱、套餐、剩余用量百分比。无需用户手动填 JWT。

## 数据源（双路径；优先 AI助手「领号」态）

本机可能同时存在两套 Cursor 登录态，且经常不一致：

| 优先级 | 来源 | 路径 | 说明 |
|--------|------|------|------|
| 1（优先） | AI助手 / cursor-renewal「领号」 | `~/.cursor-renewal/seamless_state.json` | 操作面板「当前账号」；含 email + accessToken + refreshToken |
| 2（回退） | Cursor IDE 登录缓存 | `state.vscdb` ItemTable | IDE 设置页账号；可被领号工具改写，也可能与 seamless 不同步 |

`seamless_state.json` 字段：`email`、`accessToken`、`refreshToken`、`auto_switch_enabled`、`machineIds`。  
号池远程源（仅文档记录，HUD 不调用）：`https://vaultbyte.top` → `/api/v2/cursor/credentials`。

### Cursor IDE DB（回退）

- macOS: ~/Library/Application Support/Cursor/User/globalStorage/state.vscdb
- Windows: %APPDATA%\Cursor\User\globalStorage\state.vscdb

必读 key：
- cursorAuth/accessToken          → JWT（Bearer）
- cursorAuth/cachedEmail         → 邮箱（与 IDE 设置页一致）
- cursorAuth/stripeMembershipType → 本地缓存套餐（常过期，仅作回退）

读库策略（很重要）：
1. 优先只读打开 live DB（URI mode=ro），以便读到 WAL 最新数据；不要只靠 File.Copy 快照（会过期）
2. live 失败再复制 db + 同名 -wal/-shm 到临时文件再查
3. busy_timeout ≈ 1500ms
4. SQL: SELECT value FROM ItemTable WHERE key=?

HUD 读 JWT / 邮箱策略：
1. 若 `~/.cursor-renewal/seamless_state.json` 存在且 `accessToken` 非空 → 用该 JWT；邮箱优先用文件内 `email`
2. 否则读 `state.vscdb` 的 `cursorAuth/accessToken`；邮箱优先 `cachedEmail`
3. 再空则 GetEmail → JWT `email` → JWT `sub` 截短
4. 监视两个目录变更（debounce 800ms）：`.cursor-renewal` 与 `state.vscdb` 所在目录

## 官方 API（全部 POST，Body 为 {}，Header: Authorization: Bearer <jwt>，Content-Type: application/json）
Base: https://api2.cursor.sh

1) /aiserver.v1.DashboardService/GetCurrentPeriodUsage
   - 取 totalPercentUsed（已用百分比）
   - remaining = clamp(100 - totalPercentUsed, 0, 100)
   - 展示文案优先用 displayMessage；为空则自拼 "Used x% · Remaining y%"

2) /aiserver.v1.DashboardService/GetPlanInfo
   - 取 planName（转小写），权威套餐名；本地 stripeMembershipType 仅回退

3) /aiserver.v1.AuthService/GetEmail
   - 仅当 cachedEmail 为空时使用；GetEmail 可能返回与 IDE 不一致的注册/Google 邮箱

邮箱解析优先级：
seamless_state.email（若走领号态）→ cachedEmail → GetEmail → JWT claim "email" → JWT claim "sub" 截短（取 | 后一段）

JWT：手动 Base64URL 解码 payload，不引入 JWT 库。

## UI
- 无边框、半透明深色底 (#1C1C1E, opacity≈0.94)、圆角约 8px
- 尺寸约 280×92，默认贴主屏右上角
- 始终置顶；不占 Dock/任务栏（macOS: LSUIElement / activationPolicy=.accessory；Windows: ShowInTaskbar=false）
- 可用鼠标拖动背景移动
- 布局：
  第1行：邮箱(截断26) | 套餐 | 手动刷新按钮 "R"
  第2行：进度条（显示剩余量）+ 剩余百分比
  第3行：displayMessage（截断42）
  第4行：状态行（如 left=remaining · next @HH:mm:ss）
- 百分比颜色：≤10% 鲑红；≤30% 金黄；否则浅绿
- 右键菜单：Refresh now / Exit

## 刷新逻辑
- 启动立即刷新；之后每 60s 轮询
- 监视 `.cursor-renewal` 与 state.vscdb 所在目录变更，debounce 800ms 后再刷新
- 用 JWT sub 检测账号切换；切换时状态前缀为 "switched · "
- 手动刷新前缀 "refreshed · "；领号态常规 "renewal · "；IDE 回退 "left=remaining · "
- 刷新期间禁用 R 按钮，防重入
- 失败时：标题变 "Cursor Usage"，百分比 "-"，消息显示错误摘要

## CLI
支持 --once：不启 GUI，打印 email/plan/used/remaining 及 GetPlanInfo、GetCurrentPeriodUsage 原始 JSON。

## 技术约束
- 零第三方依赖；只用系统库
  - Windows: .NET Framework 4.x + WinForms + winsqlite3.dll → 单文件 exe
  - macOS: Swift 5.9+ / AppKit + 系统 libsqlite3；HTTP 可用 /usr/bin/curl 同步调用（避免 URLSession 主线程死锁）
- macOS 13+；打成可双击的 .app（AppKit GUI 需要 bundle；裸 Mach-O 双击会被杀）
- ad-hoc codesign；可选再打 DMG（含 Applications 快捷方式）
- 不依赖本仓库的 Node gateway；HUD 独立运行

## 交付
给出完整可编译源码、构建脚本、简短 README 用法。
```

---

## 规格速查

| 项 | 值 |
|----|----|
| 产品名 | Cursor Usage HUD |
| 轮询间隔 | 60s |
| DB 监视 debounce | 800ms |
| 窗口 | 280×92，置顶，可拖动，无任务栏/Dock 图标 |
| 进度条含义 | **剩余**用量（非已用） |
| 套餐权威源 | `GetPlanInfo.planName` |
| 邮箱权威源 | 优先 `~/.cursor-renewal/seamless_state.json` 的 `email`，否则 `cursorAuth/cachedEmail` |
| JWT 权威源 | 优先 `seamless_state.accessToken`，否则 `cursorAuth/accessToken` |
| 用量权威源 | `GetCurrentPeriodUsage.totalPercentUsed` |

### 本地路径

| OS | 领号态 (优先) | Cursor IDE DB (回退) |
|----|---------------|----------------------|
| macOS / Windows | `~/.cursor-renewal/seamless_state.json` | 见下表 `state.vscdb` |

| OS | state.vscdb |
|----|-------------|
| macOS | `~/Library/Application Support/Cursor/User/globalStorage/state.vscdb` |
| Windows | `%APPDATA%\Cursor\User\globalStorage\state.vscdb` |

### API

| 用途 | URL |
|------|-----|
| 用量 | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage` |
| 套餐 | `POST https://api2.cursor.sh/aiserver.v1.DashboardService/GetPlanInfo` |
| 邮箱 | `POST https://api2.cursor.sh/aiserver.v1.AuthService/GetEmail` |

请求体一律 `{}`，鉴权：`Authorization: Bearer <accessToken>`。

---

## 本仓库对照实现

| 平台 | 源码 | 构建 |
|------|------|------|
| Windows | `hud/Program.cs` | `hud/build.ps1` → `CursorUsageHud.exe` |
| macOS | `hud/macos/Sources/main.swift` | `hud/macos/build.sh` → `.app` + CLI |
| macOS 分发 | — | `hud/macos/package-dmg.sh` → `CursorUsageHud.dmg` |
| 参考脚本 | `scripts/get-cursor-usage.ps1` | 仅 CLI 拉用量，无 GUI |

### 本地验证

```bash
# macOS
cd hud/macos && ./build.sh
./CursorUsageHud --once
open CursorUsageHud.app
./package-dmg.sh
```

```powershell
# Windows
cd hud
.\build.ps1
.\CursorUsageHud.exe --once
.\CursorUsageHud.exe
```

---

## 已知坑（实现时务必处理）

1. **WAL**：Cursor 写库走 WAL，只复制 `.vscdb` 会读到旧 token；优先 live 只读 / 连带复制 `-wal`/`-shm`。
2. **套餐缓存脏**：`stripeMembershipType` 经常过期，必须打 `GetPlanInfo`。
3. **邮箱不一致**：`GetEmail` 可能和 IDE 设置页不同；有领号工具时，IDE `cachedEmail` 还可能与 `seamless_state.email` 不是同一账号（例如 IDE 显示被注入号，操作面板仍是领到的号）——HUD 优先 seamless。
4. **AI助手写盘**：`AI助手-*.exe`（`cursor-renewal` / `com.cursor-renewal.app`）会把领到的 JWT 写入 `~/.cursor-renewal/`，并可能再 `INSERT OR REPLACE` 进 `state.vscdb` 的 `cursorAuth/*`，同时改机器指纹 / 补丁 Cursor `main.js` 等；**不是**依赖 Frida 改 UI 显示。
5. **macOS App Bundle**：AppKit GUI 必须打进 `.app`（`Info.plist` + `LSUIElement=true`），并 ad-hoc `codesign`；否则双击启动会被系统杀掉。
6. **Gatekeeper**：adhoc 签名的 DMG 分发给别人时，对方可能需右键 → 打开，或 `xattr -cr …app`。
7. **架构**：当前 macOS 默认构建多为 arm64；要兼容 Intel 需单独做 universal。
8. **与 Gateway 无关**：HUD 自己读 JWT 调 api2，不依赖 `localhost:4647`。

---

## 最小验收清单

- [ ] 未登录 Cursor 时给出明确错误（缺 DB / 无 accessToken）
- [ ] 已登录时显示邮箱、套餐、剩余 %
- [ ] `--once` 能打印 JSON
- [ ] 60s 自动刷新；点 R 立即刷新
- [ ] 切换账号后（改写 seamless_state.json 或 state.vscdb）能在约 1s 内跟上
- [ ] 存在 `~/.cursor-renewal/seamless_state.json` 时优先用其 email/JWT（与操作面板一致）
- [ ] 百分比颜色随分档变化；进度条表示剩余
- [ ] 右键可退出；无 Dock/任务栏常驻图标
