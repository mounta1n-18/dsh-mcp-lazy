# dsh-mcp-lazy

为 DeepSeek Harness（DSH）的 MCP 服务器提供**渐进式披露**。

> **出问题了？** 直接跳到 [检修](#检修五分钟自查)：一条自检命令、一张症状表、改完代码怎么重载。

`@deepseek-ai/dsh-mcp-client` 会把每个 MCP 工具注册成完整的模型可见工具定义，并在每次请求中发送。像 REA 这样有 207 个工具的服务器，会在模型还没开始干活前就占掉约 4.7 万 token 静态上下文。本插件把 MCP 表面压成**每服务器一行简介 + 一个元工具**，只有 agent 主动加载时才把该服务器的真实工具放进上下文。

## 它做什么

- 系统提示里保持一行一个服务器：`- rea: 逆向工程与二进制分析 (207 tools)`。
- 注册一个 `mcp` 元工具，支持 `list` / `load` / `unload`。
- `load` 解除该 agent 对该服务器的限制；真实工具通过 DSH 原生的"会话中途新增工具"路径进入下一次请求，带完整参数 schema，之后按原生方式调用（校验、审批、守卫、超时、并行调度都不变）。
- **调用自愈**：全局 `ctx.tools.guard()` 会拦截对隐藏工具的调用（`unload` 后的旧历史、拼错名字、刚加进来的服务器），返回应该执行的 `load` 调用，而不是干巴巴的 `UNKNOWN_TOOL`；`mcp list` 还会显示被挡在上下文外的 schema 估算 token。
- **新 MCP 服务器默认遵循本模式**：插件在 `tools/change` 时重建索引，新注册的 `mcp__<server>__*` 服务器会在下一次装配时被隐藏，并自动获得一行目录（摘要默认 `N tools`；在 `servers.<name>` 配一句简介效果更好）。
- **持续登记**：从 Host 启动起，每次索引重建或后台巡检都会把"当前存在的 MCP 行"写进 `expectedFile`。服务器后来消失时，面板仍能指出是哪一行不见了，不需要你事先打开过面板。
- **后台健康巡检**：默认每 30s 重新判定一次每台服务器的状态（工具是否还在、HTTP 端点是否可达、最近一次工具调用是否失败），并把结论同时给面板和模型（`mcp list` / `mcp load` 会带健康注记）。
- **不做 dispatcher、不重写 MCP 客户端、不改 `system-prompt/assemble`。** 连接、重连、资源、图片处理仍由 `dsh-mcp-client` 负责。

## 登记与健康：面板之外也在工作

懒加载本身不需要登记表；这两样东西解决的是**"服务器本该在、现在却不见了"**和**"它还在，但已经死了"**。

### 登记表（`expectedFile`）

- 写入时机：Host 启动、每次 `tools/change` 重建索引、以及后台巡检。**不是**只在打开设置页时写。
- 内容：服务器名、简介、传输方式、`firstSeen` / `lastSeen`。来源合并三处——MCP 客户端加载行、已注册工具、上一次的登记表。
- 只增不删：服务器从配置里消失后，条目留着，面板标 **配置缺失（missing）**。确认不要了，在面板点 **忘记**，或 `POST /mcp-lazy/forget`（只接受既不在配置、也没注册工具的墓碑，仍在的服务器返回 409）。
- `lastSeen` 心跳受 `expectedTouchMs` 节流（默认 5 分钟），面板每 5s 轮询不会反复写盘。

### 健康度怎么算

DSH 的 MCP 客户端不暴露健康 API（没有 service、没有事件，连接失败只写日志），所以结论由三路证据推断：

| 证据 | 含义 | 强度 |
| --- | --- | --- |
| 工具还在注册表里 | 至少注册成功过 | 基线 |
| 最近一次工具调用失败且有传输措辞 | 真的连不上（stdio 唯一可用的信号） | 最高 |
| HTTP HEAD 探活（仅 streamable-http） | 端点是否应答；非 5xx 即视为可达 | 补充，需连续两次失败 |

规则：调用失败 > 探活连续失败两次 > 有工具即视为健康；没有工具时，启动宽限期内是 **连接中**，之后是 **未连接**；探活通但零工具则是 **已连通但无工具**（通常意味着服务器拒绝注册工具或工具全被过滤）。调用失败证据有 TTL（`failureTtlMs`，默认 5 分钟），过期自动失效；一次成功调用会立刻清掉失败证据和探活缓存。

为什么探活要连续两次：HEAD 不建立 MCP 会话，代理抖动、DNS 超时、令牌刚好过期都会让它单次失败。一次失败不改变结论（`probeStatus` 仍会显示 0，便于排查），连续两次才把有工具的服务器标为 **未连接**。

后台巡检由 `healthMonitorMs` 控制（默认 30000，0 关闭，最低 5000）。它不新增权限、不改 MCP 连接，只是定期重算并记住结论。

## agent 怎么知道

1. 稳定目录的标题写明规则：MCP 工具默认隐藏，调用 `mcp__<server>__` 前先 `load`，在加载前不要宣称某个 MCP 能力不可用。
2. `mcp` 工具描述重复调用顺序和"下一步生效"规则。
3. 隐藏工具不在请求里；模型猜名字或引用旧历史时，全局 `ctx.tools.guard()` 会返回应该执行的 `load` 调用。
4. `mcp list` 显示每个 agent 的状态和被挡在上下文外的 schema 估算 token。
5. 新注册的 MCP 服务器会在下一次装配时出现在目录并被隐藏；默认 `minTools: 1`，不需要额外配置。
6. `mcp list` 的每一行会带健康注记（`; health: unavailable (...)`），`mcp load` 对宕机服务器会先警告"它现在看起来是宕的"；模型因此能在调用前就知道该重试、换路还是告诉用户。

## 再加一个 MCP 服务器

照常用 `@deepseek-ai/dsh-mcp-client` 加一个服务器（通常是一个只含配置的 bundle），不需要改代码：

- 下一次装配时，插件通过 `tools/change` 看到新的 `mcp__<server>__*`，默认按 `minTools: 1` 隐藏，并在目录里加一行 `- <server>: N tools`。
- 在 `mcp-lazy` 的配置里加 `servers.<server>: "一句简介"`，目录会更好读；不配就自动用服务器自己的 instructions（见下），最后才回退到工具数。
- 模型在加载前调用新工具时，守卫会返回应该执行的 `load` 调用。

### 谁来写简介？

优先级：

1. 插件配置里的 `servers.<server>`——用户/agent 手工覆盖。
2. **MCP 服务器自己的 instructions。** `dsh-mcp-client` 本来就会注入 `mcp:<server>` 提示词段；插件在装配时读它，取第一句作为目录简介（`autoSummary: true`，默认开）。不调 LLM、不用额外脚本。
3. 服务器没有 instructions、也没配简介时，回退到 `N tools`。

自动摘要的来源是 `dsh-mcp-client` 的 `mcp:<server>` 提示词段；如果这段不存在（服务器没提供 instructions，或未来桥接改名），就回退到 `N tools`，配置里的 `servers.<server>` 仍然有效。

如果自动截出来的句子不理想，安装该 MCP 的 agent 可以 `mcp list` 看一眼工具，然后在配置里补一句 `servers.<server>`。

参考机器上用全新 subagent 实测：隐藏状态下调用 `mcp__rea__list_documents` 返回
`Error: MCP server "rea" is lazy-loaded: ... Call mcp({action:"load",server:"rea"}) first`；
`load` 后下一步正常派发，`unload` 后同样的提示再次出现。

## 为什么不会被 DSH 更新覆盖

只使用公开 Host 服务：

| 用途 | API |
| --- | --- |
| 枚举存活 agent | `ctx.agents.list()` |
| 按 agent 隐藏工具 | `agent.ctx.tools.restrict({ deny })` |
| 读取 MCP 注册表 | `ctx.tools.schemas()` |
| 稳定目录 | `ctx.systemPrompt.section()`（或 `.context()`） |
| 监听注册表变化 | `tools/change` 事件 |
| agent 生命周期 | `agent/created`、`agent/disposed` |
| 本步真正被接纳的工具 | `system-prompt/assemble` 的第二参数里的 `context.toolSet.view(context.scope)` |

**一处例外要说明**：枚举"MCP 客户端加载行"用的是 `ctx.loader.entries()`（Cordis loader 的公开对象，但 `entries()` 本身不是 DSH 文档化的服务方法）。它只用于登记表与面板展示；拿不到时退化为"只登记已注册工具的服务器"，懒加载本身不受影响。

任何 API 变化时插件**失败开放**：只记日志、保持工具全量可见，不会把会话弄坏。插件不写入 DSH 安装目录，DSH 升级替换 `app.asar` 不会覆盖它。

### 没有脚本，也没有改 DSH 本体

- DSH 安装目录里一个文件都没改。`plugin_manager` 只把 bundle 记进 profile 的 `package.json` 和 lockfile；DSH 升级替换 `app.asar`，profile 里的 bundle 原样保留。
- 没有 watcher 脚本、外部定时脚本、cron，也没有包外的文件。触发源是 `index.js` 里处理的 Host 事件：`tools/change`、`agent/created`、`agent/disposed`、`system-prompt/assemble`，外加一个用于健康巡检的 `unref` 定时器（不会阻止进程退出）。
- 每次触发都从 `ctx.tools.schemas()` **全量重算**，没有"逐个把新工具加进列表"的逻辑。新工具自动被包含，因为策略作用于整个注册表。
- 插件被停用、卸载或加载失败时，所有工具可见（fail-open），不会出现"工具藏了但没人知道"。
- 如果 `complete` persona 或提示词 API 变化把目录顶掉，`system-prompt/assemble` 自检会记日志并 fail-open；默认的 `catalogPlacement: context` 本来就不受 complete persona 影响。
- 同一个监听器里还有 pull 审计：拿本步真正被接纳的工具集（`context.toolSet.view(context.scope)`）与索引比对，索引更新前先出现的受管工具会在微任务里刷新，漏掉一次 `tools/change` 最多只晚一步。

### 全注册表模式（`scope: "all"`）

DSH 不允许一个插件直接改写另一个插件的注册。最强的官方权限是 per-agent 的 `ctx.tools.restrict()`——它作用于**整个全局注册表**。`scope: "all"` 就是把这层权限用到 `core`（以及元工具）之外的**所有**全局工具上：

- MCP 工具仍按 `mcp__<server>__` 分组；其余受管工具都进 `other` 组。
- `mcp load other` 展开所有非 MCP 长尾工具；`core` 里的工作集（`read`、`write`、`edit`、`pwsh`、`skill` 等）始终直通。
- **任何插件**新加的工具（不论是不是 MCP）都会在下一次重算时被包含、默认隐藏。这就是"override 所有插件"的可实现形态。
- 代价：`core` 太小可能把 agent 马上要用的工具藏起来。默认仍是保守的 `scope: "mcp"`；要用 `all` 请认真维护 `core` 列表。

### 为什么不用 `deferLoading`？

DSH 已有 `ToolSchema.deferLoading` 和配套的 `defer_loading` / `tool_addition` 线协议。但 `dsh-mcp-client` 自己逐个注册工具、没有暴露 defer 开关，插件也无法改动别的插件已注册的定义。用官方文档化的 `ctx.tools.restrict()` 隐藏、再通过解除 deny 产生原生"工具新增"，是最贴近官方的路线：不需要改写 `system-prompt/assemble`，不需要 dispatcher，也不碰私有 API。三个小的 MCP 资源工具（`list_mcp_resources` 等）保持常驻。

## 设置页（Web）

设置 → **MCP** 是同一个 bundle 的可视管理面：

- **服务器名**是强调行；**简介**是弱化行，直接使用目录给 agent 的同一字符串（`summaryOf(entry, config)`），不是另写一份描述。
- 工具数和估算 schema tokens 作为次级信息。
- **状态只有一个来源。** Host 把 configured / 注册表 / `expectedFile` / 健康 / 开关五个来源交给纯函数 `buildInventory()`，每台服务器只得到**一个** `status`，面板只按它挑徽标：`active`（正常懒加载，**无徽标**）、`connecting`（连接中）、`down`（未连接；具体因由在 `reason` 里：`call-failed` / `unreachable` / `no-tools` / `unavailable`）、`always-visible`（披露未生效，琥珀色）、`unconfigured`（工具在、但没有任何配置行，琥珀色）、`unknown`（**读不到** MCP 配置，琥珀色）、`removed`（配置缺失，红色）。状态由后台巡检持续更新（`healthMonitorMs`），页面轮询只是读取结论，不触发探活。
- **"配置为空"与"读不到配置"不再混为一谈。** loader 扫描抛错时，页面顶部出现红色横幅"无法读取 MCP 配置：…"，同一批行标成 **配置不可读（unknown）**，而不是像以前那样一律当成 **配置缺失**。真的删掉的行仍然是 `removed`，并且只在"扫描成功"时才会出现这个判断。
- Streamable HTTP 服务器会主动发一次无副作用的 HEAD 请求探活；只要不是 5xx 都算可达，所以 WAF/会话规则引起的 401/403 不会把正常 bridge 误标红。探活需要**连续两次**失败才把服务器判成宕机，避免一次抖动让 46 个工具的正常服务器变红。stdio 断开只能在下一次工具调用失败时发现（bridge 会保留旧工具定义），显示为 **连接异常**。
- **配置缺失**的行只提供"忘记"按钮（不提供开关）：那一行已经不在配置里，开关无从作用。`unconfigured` / `unknown` 行同样不渲染开关。
- 页面提供每服务器开关；新增/移除 MCP 行本身仍走 profile 配置（面板不会安装插件）。
- **插件面板边界**：MCP 服务器是 profile 行（`@deepseek-ai/dsh-mcp-client`），不是 bundle；插件面板只列插件。不要把 MCP 服务器装成独立 bundle，否则它会出现在插件面板里。
- **每服务器开关**：MCP 面板的开关只控制向 agent 的披露；关掉后目录和工具都隐藏，连接不断。状态存在 `stateFile`（bundle 默认 `~/.dsh/mcp-lazy-state.json`），重启后保留。
- 数据来自 Host 自己 Web server 上的 `GET /mcp-lazy/servers`；开关走 loopback `POST /mcp-lazy/toggle`；headless profile 不提供。
- 页面是同一个包的 Client half（`client.js`、`dsh.client`）。**客户端模块图在 Host 启动时读取**：这个 bundle 第一次新增 `dsh.client` 声明后，需要重启 DSH 并刷新页面；之后纯客户端改动只有在部署运行 dev client build 时才会通过 Client HMR 热加载。

## 缓存影响

DSH 的请求头 diff 会把新增工具转成 `tool_addition` developer 消息，并以 `defer_loading: true` 追加到 tools 数组末尾。官方真 provider e2e 断言：新增后的首个请求仍复用之前的对话前缀（`cacheReadTokens >= 前置输入 − 256`）。`load` 走的正是这条路径，**不会重读历史**。

真实会话实测（253 个工具，其中 207 个 MCP）：

| 指标 | 之前 | 启用后 |
| --- | ---: | ---: |
| 工具定义 | 238,322 B | 约 50,600 B；MCP 隐藏时约 0 |
| 首请求总输入 | 71,138 tokens | 约 24,000 tokens |
| 首请求缓存读取 | 65,408 tokens | 约 18,000 tokens |
| 每步缓存前缀 | 368,896 tokens | 约 321,900 tokens |

**命中率数字可能下降（首请求 92% → 约 76%），但不是变差**：静态前缀从 62k 缩到 15k，分母缩得更快。真正下降的是绝对缓存 token 量和上下文占用，每步少约 4.7 万 token。

注意：

- **在会话边界安装**。在运行中的会话里隐藏工具，对请求头来说是一次"移除"，那一次请求可能不命中缓存。
- **`unload` 可能付一次缓存 miss**。移除不在官方"追加"保证内，非必要不用。
- 不支持 `toolUpdate` 的路由（如 `pi-ai`）在表面变化时会退回合并提示词；`deepseek-flash` 是 `addition-only`，没问题。

参考机器上用一个全新 subagent 实测：初始 41 个工具（47,409 B）。`load` 加入 207 个 REA 工具，该请求一次性付了 51,723 个未命中 input tokens；之后请求读取 71,424 个缓存 tokens。`unload` 让缓存读取从 71,552 掉到 21,248，正是预期的"移除"代价。加载后的工具能正常派发（返回工具级 `target_unavailable`，不是 `UNKNOWN_TOOL`）。

## 安装

这是 DSH profile bundle，请通过官方 `plugin_manager`（或插件管理页面）安装，不要手改 profile：

```jsonc
plugin_manager { "action": "install_bundle", "target": "C:\\DSHprojects\\dsh-mcp-lazy" }
```

bundle patch 会插入一行：

```yaml
- insert:
    - id: mcp-lazy
      name: dsh-mcp-lazy
      config:
        servers:
          rea: 逆向工程与二进制分析
```

`config` 可选。安装后通过 HMR 生效；建议新开一个会话获得最干净的首请求。

## 用法

模型看到目录后调用：

```jsonc
mcp({ "action": "list" })                       // 服务器、简介、状态
mcp({ "action": "load", "server": "rea" })      // 启用 rea 的全部工具
mcp({ "action": "unload", "server": "rea" })    // 再次隐藏
```

`load` 从**下一步**生效：当前这一步的工具列表已经冻结。工具结果里会明确提示。如果模型仍然直接调隐藏工具，守卫会返回应该执行的 `load` 调用。

## 配置

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 不卸载直接停用。 |
| `toolName` | `mcp` | 元工具名；冲突时自动降级为 `mcp_tools`。 |
| `servers` | `{}` | `serverName` → 一行简介（字符串或 `{ summary }`）。 |
| `autoSummary` | `true` | 没配 `servers` 简介时，取 MCP 服务器 instructions 的第一句作为目录简介。 |
| `minTools` | `1` | 工具数达到此值就隐藏；调大可以让小服务器保持常驻。 |
| `alwaysLoaded` | `[]` | 永不隐藏的组名（含 `other`）。 |
| `scope` | `mcp` | `mcp` = 只管理 `mcp__*`；`all` = 管理 `core` 之外的所有全局工具（全注册表）。 |
| `core` | 内置列表 | `scope: "all"` 时始终直通的精确工具名。 |
| `otherGroup` | `other` | 全注册表模式下非 MCP 工具的分组名。 |
| `catalogPlacement` | `context` | `context`（运行时上下文，不怕 complete persona）或 `section`（系统提示）。 |
| `index` | `names` | `load` 返回的索引：`names`、`summary` 或 `none`。 |
| `descriptionChars` | `40` | 简介/用途截断长度。 |
| `maxIndexChars` | `4000` | `load` 索引上限。 |
| `healthGraceMs` | `15000` | 配置了但没注册出工具的服务器，显示 **连接中** 多久后标记 **未连接**。 |
| `healthProbe` | `true` | 对 Streamable HTTP 服务器主动探活。 |
| `healthProbeTimeoutMs` | `3000` | 单次探活超时。 |
| `healthProbeCacheMs` | `5000` | 探活结果复用时长。 |
| `healthMonitorMs` | `30000` | 后台健康巡检周期；`0` 关闭，非 0 时最低 5000。 |
| `failureTtlMs` | `300000` | 工具调用失败证据的有效期；过期后不再据此判宕机。 |
| `expectedTouchMs` | `300000` | `lastSeen` 心跳最快写入间隔，避免每次面板轮询都写盘。 |
| `stateFile` | `""` | MCP 面板开关状态文件；bundle 默认 `~/.dsh/mcp-lazy-state.json`。 |
| `expectedFile` | `"~/.dsh/mcp-lazy-expected.json"` | 持续登记的镜像：记录见过的每个 MCP 行（名字/简介/传输/首末次时间），撑起「配置缺失」徽标与面板找回；`""` 关闭。 |
| `restoreOnResume` | `true` | 从工具新增历史恢复已加载服务器。 |
| `allowUnload` | `true` | 是否暴露 `unload`。 |

补丁会整体替换该行的 `config`，改的时候请把要保留的键都写全。本包刻意不提供 Schemastery schema（保持零依赖），所以设置页不会生成表单；`resolveConfig` 在激活时校验并收敛每个字段。

## 限制

- 只对**全局注册**的工具生效（`dsh-mcp-client` 和普通插件的默认挂载方式）。注册在 agent 自身作用域的工具始终可见。
- `scope: "mcp"` 下按 `mcp__<server>__` 分组；服务器名本身含 `__` 时，请在 `servers` 里显式列出以免歧义。
- `scope: "all"` 下 `other` 是单一桶；请认真维护 `core`，需要更多常驻工具时调大 `minTools` 或把工具加进 `core`。
- 新发现的服务器若没配 `servers` 条目，目录里只显示 `N tools`；建议补一句简介。
- 已加载状态按存活 agent 保存，resume 时从工具新增历史恢复；compaction 后可能需要重新 `load`。
- 目录刻意不含状态。不要往目录里加"已加载"标记，否则每次 `load`/`unload` 都会改写稳定前缀，造成缓存 miss。
- DSH 安装目录零改动；只有 profile 的 `package.json`/lockfile 由 `plugin_manager` 记录 bundle，升级不会覆盖。

## 检修（五分钟自查）

面板由 Host 自己提供，直接问它——返回的 JSON 才是事实，页面只是渲染：

```sh
curl -s "http://127.0.0.1:<gui-port>/mcp-lazy/servers"
# PowerShell: Invoke-RestMethod "http://127.0.0.1:<gui-port>/mcp-lazy/servers"
```

`<gui-port>` 就是 DSH Web GUI 地址里的端口。返回体里三块关键信息：

- `servers[]`：每台服务器一个 `status`（`active` / `connecting` / `down` / `always-visible` / `unconfigured` / `unknown` / `removed`），外加 `health`、`reason`、`toolCount`、`mechanism`、`abnormal`。**先看 `status`**，它是唯一判定；`reason` 只解释 `down` / `removed` / `unconfigured` 的具体因由（`call-failed` / `unreachable` / `no-tools` / `unavailable` / `not-configured` / `configured-missing` / `scan-failed`）。
- `scan`：`{ ok, error }`。`ok: false` 表示插件根本读不到 MCP 配置（loader 扫描失败），此时任何 "配置缺失" 判断都不可信，行会标成 `unknown`。
- `counts` 与 `monitorMs`：各状态计数，与当前巡检周期（0 = 关闭）。

| 症状 | 先查什么 | 怎么修 |
|---|---|---|
| 没有 `mcp` 工具、提示里也没有 MCP 那行 | `plugin_manager list_plugins` → `include:mcp-lazy` 应为 `enabled: true`、`fiberPhase: active` | 重新启用该行；行本身都没了，说明 bundle 被从 `dsh.profile.bundles` 里删了 |
| 面板顶部红字**无法读取 MCP 配置**、行全是**配置不可读** | 返回体 `scan.ok === false`，`scan.error` 有原因 | 说明 loader 的行结构变了（DSH 升级）或插件上下文已失效：先重载 `include:mcp-lazy`；仍失败就看 `scan.error` 指向哪个字段 |
| 某个服务器显示**配置缺失** | 它没有任何 `@deepseek-ai/dsh-mcp-client` 行，且 `scan.ok === true`（否则是 `unknown`） | 把该行加回去；名字、传输方式、上次的简介都在 `expectedFile` 里。确认不要了，在面板点 **忘记**（或 `POST /mcp-lazy/forget`） |
| 某个服务器显示**未纳入监管** | 工具已注册，但没有任何配置行认领它 | 正常只有 preset / 嵌入式宿主会这样；若你在 profile 里配过它，说明那条行没被 loader 读到 |
| 某个服务器**未连接** | 配置在，但工具一个没注册 | 远程：token、URL、网络；stdio：命令路径与参数；看 Host 日志里 `[mcp-lazy]` 和 `[mcp]` 开头的行 |
| `load` 之后工具还是看不见 | 面板开关把它关了 | `stateFile`（`~/.dsh/mcp-lazy-state.json`）里删掉这个名字，或整个文件删掉 |
| 改了 `index.js` / `client.js` 没变化 | 插件代码是挂载时读的，HMR 不监听这个包 | `plugin_manager set_plugin` → `include:mcp-lazy` 先 `false` 再 `true` |
| `/mcp-lazy/*` 返回 404 | headless profile，或端口不对 | 这两条路由只在组装了 `webServer` 的地方存在 |
| `/mcp-lazy/*` 返回 500 | 旧代码在跑（进程早于源码修改），或数据里有旧代码没处理的行 | 重载 `include:mcp-lazy`；仍 500 就看日志里的 `settings route failed: <stack>` |

两个文件都是自愈的——缺失或格式坏了当空处理，不会报错：`stateFile` 存被关掉的服务器，`expectedFile` 是「缺失」徽标背后那份只增不减的记忆（删了就等于忘掉面板见过的一切）。

回滚：同目录的 `dsh-mcp-lazy-0.1.0.tgz` 是打包时的快照，用前先看它的日期；否则用你自己的备份覆盖回去，再重挂插件行。

## 兼容性

面向 DSH `0.2.1-rc.2`（desktop profile，`deepseek-flash`，`toolUpdate: addition-only`）编写与验证。DSH 仍是 pre-1.0；插件只依赖公开接缝，接口变动时失败开放。

## 许可证

MIT，见 [LICENSE](./LICENSE)。
