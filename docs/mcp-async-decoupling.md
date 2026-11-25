# DSH 启动解耦：MCP 后台连接（2026-11-25）

## 结论

桌面端窗口的显示时机绑定在 Host「插件树装配完毕」上（`reconcileBackend` → `backend.start`
→ `openInitialWindow`），而 `@deepseek-ai/dsh-mcp-client` 的 `apply` 里有一句
`await connection.ready`，它的设计就是「插件激活等首次连接 + 首次工具同步」。

冷启动实测（14:38 那次）：host 出生 14:38:12.568，界面 14:38:30.806 = 18.24 秒；
其中 CPU 几乎为零的 6.5→17.7 秒全在等 GitHub 的 TCP 握手（`140.82.113.22:443`
在 +11.5s 是 `SYN_SENT`，界面出现时仍是 `SYN_SENT`）。当时 github 行
`startupTimeoutMs` 是 15000，正好对上。11-21 之前不设预算 → 走 SDK 默认 60 秒，
就是最初「要等一分多钟」。

## 改了什么

1. `C:\DSH Plugin\dsh-mcp-lazy\async.js`（新）：包装行 `dsh-mcp-lazy/async`。
   配置 schema / 工具名 / 重连策略 / `serverName` 占位全部沿用 `dsh-mcp-client`，
   只是把 `ctx.plugin(client, config)` 放到子 fiber 且不 await → 宿主不等 MCP。
   子 fiber 由 cordis 作为父 fiber 的 effect 回收，不需要手动 dispose。
2. `C:\DSH Plugin\dsh-mcp-lazy\async-status.js`（新）：`globalThis` 上的相位登记表，
   两个 ESM 入口共用（模块作用域各自一份，不能用模块级 Map）。
3. `index.js`：`MCP_CLIENT_PLUGINS` 同时认 `@deepseek-ai/dsh-mcp-client` 与本包
   `dsh-mcp-lazy/async`；扫描行多带 `plugin` 字段；`buildInventory` 传入相位表。
4. `lib/router.js`：配置了但没工具时按相位判定 —— `loading/starting/connecting`
   → `connecting`，`failed/closed` → `down`，`credentials` → `down/waiting-credentials`；
   行里新增 `phase`、`firstConnect`，`mechanism` 对这类行改为 `lazy`（原来误报 `unconfigured`）。
5. `client.js`：`firstConnect` 时徽标显示「首次连接中…」（英文 First connection…）。
6. `package.json`：exports 加 `"./async"`，files 加两个新文件。
7. 配置：`~/.dsh/cordis.patch.yml` 与 `~/.dsh/profiles/desktop/cordis.patch.yml`
   的 4 条 MCP 行 `name` 从 `@deepseek-ai/dsh-mcp-client` 改为 `dsh-mcp-lazy/async`，
   `config` 原样（含 github 7000 / 其余 8000 的 startupTimeoutMs）。

备份：`C:\DSH Plugin\dsh-mcp-lazy\.backup-20261125-mcp-async\`（含两份 yml 副本）。

## 验证（隔离 home，未动主 profile）

复制 `profiles/desktop` 到临时 home → `profiles/boottest`，用
`DSH_HOME=<临时> dsh --profile boottest --host 127.0.0.1 --port 0 --no-open` 冷启动：

| 事件 | 时刻 |
| --- | --- |
| 打印 URL（Host ready） | +3.2s |
| 四个 MCP 全部 connected | +7.0s（ready 之后 3.7 秒） |

即窗口不必再等 MCP。健康接口四台服务器 `active/connected`，工具数 46/23/5/36 与主实例一致，
`phase:"connected"`、`firstConnect:false`。

单元测试 39/39 通过（新增一条「按相位判定延迟行」的用例）。

## 回滚

把两份 yml 里 4 条行的 `name` 改回 `@deepseek-ai/dsh-mcp-client` 重启即可；
插件代码可整目录回滚自 `.backup-20261125-mcp-async\`。

## 复现隔离测试

1. `robocopy %USERPROFILE%\.dsh\profiles\desktop <tmp>\profiles\boottest /E`
2. `set DSH_HOME=<tmp>` + `ELECTRON_RUN_AS_NODE=1`，跑
   `resources\app.asar\dsh\node_modules\@deepseek-ai\dsh\lib\bin.js --profile boottest --host 127.0.0.1 --port 0 --no-open`
3. 脚本 `check-async-rows.mjs`（yml 合成 + 模块解析）、`check-client-anchor.mjs`（从 host 锚点解析客户端包）。
