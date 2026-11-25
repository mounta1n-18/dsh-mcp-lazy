window.__ModuleLoader__.load({
  id: 'dsh-mcp-lazy',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'mcpLazy'
    const zh = {
      nav: 'MCP',
      title: 'MCP 服务器',
      intro: '查看当前接入的 MCP。简介与披露给 agent 的目录完全一致；开关只控制向 agent 的披露，不改变 MCP 连接；未连接或未生效渐进式披露的服务器会被标注。',
      loading: '正在读取 MCP 列表…',
      refreshing: '刷新中…',
      refresh: '刷新',
      enable: '启用',
      disable: '停用',
      error: '无法读取 MCP 列表。',
      empty: '当前没有接入任何 MCP 服务器。',
      tools: '个工具',
      tokens: 'tokens',
      abnormal: '披露未生效',
      disclosureInactive: '披露未生效',
      missing: '配置缺失',
      missingHint: '这行 MCP 配置已经不在了（常见于别人整文件重写了 cordis.patch.yml）。把这行加回去即可恢复；行可由 ~/.dsh/mcp-lazy-expected.json 里的记录找回名字与传输方式。',
      forget: '忘记',
      forgetHint: '从登记表里删掉这条已消失服务器的记录。只有既不在配置里、也没有注册工具的条目才能删除。',
      forgetFailed: '无法删除这条记录',
      unavailable: '未连接',
      callFailed: '连接异常',
      noTools: '已连通但无工具',
      connecting: '连接中',
      firstConnect: '首次连接中…',
      firstConnectHint: 'DSH 已经打开，这台 MCP 服务器正在后台建立连接。连上之前它的工具不会出现在目录里；连上后这里会变成「46 tools」这类计数。',
      startupFailed: '启动失败',
      waitingCredentials: '等待凭据',
      unconfigured: '未纳入监管',
      unconfiguredHint: '工具已经注册，但插件读不到对应的 MCP 配置行，因此无法控制它的披露、也无法判断它是怎么来的。常见原因：这条服务器由别的插件注册，或配置文件暂时读不到。',
      unknown: '配置不可读',
      unknownHint: '插件读不到 Cordis 的插件行，所以无法判断这台服务器是"被删了"还是"只是看不见"。重启 DSH 后再看；如果一直这样，检查加载器日志。',
      scanFailed: '无法读取 MCP 配置：',
      scanFailedHint: '这不是"没有配置"——插件读不到加载器里的插件行。不要把下面的行当成被删除的配置。',
    }
    const en = {
      nav: 'MCP',
      title: 'MCP servers',
      intro: 'Inspect connected MCP servers. Summaries are exactly what the agent sees; switches control agent disclosure only, not the MCP connection. Servers that are unreachable or lack active progressive disclosure are marked.',
      loading: 'Loading MCP servers…',
      refreshing: 'Refreshing…',
      refresh: 'Refresh',
      enable: 'Enable',
      disable: 'Disable',
      error: 'Could not load MCP servers.',
      empty: 'No MCP servers are connected.',
      tools: 'tools',
      tokens: 'tokens',
      abnormal: 'Disclosure inactive',
      disclosureInactive: 'Disclosure inactive',
      missing: 'Missing',
      missingHint: 'This MCP row is gone from the profile (usually a whole-file rewrite of cordis.patch.yml). Add it back to restore the server; its name and transport are remembered in ~/.dsh/mcp-lazy-expected.json.',
      forget: 'Forget',
      forgetHint: 'Remove this vanished server from the registry mirror. Only entries that are neither configured nor registering tools can be deleted.',
      forgetFailed: 'Could not forget this entry',
      unavailable: 'Unavailable',
      callFailed: 'Connection error',
      noTools: 'Reachable, no tools',
      connecting: 'Connecting',
      firstConnect: 'First connection…',
      firstConnectHint: 'DSH is already open; this MCP server is connecting in the background. Its tools stay out of the catalog until it connects — once it does, this shows a count like "46 tools".',
      startupFailed: 'Start failed',
      waitingCredentials: 'Waiting for credentials',
      unconfigured: 'Not supervised',
      unconfiguredHint: 'Tools are registered, but no MCP loader row matches them, so the plugin cannot control disclosure or explain where they came from. Usually another plugin registered them, or the configuration was unreadable.',
      unknown: 'Config unreadable',
      unknownHint: 'The plugin could not read Cordis loader rows, so it cannot tell "deleted" from "invisible". Restart DSH and look again; if it persists, check the loader log.',
      scanFailed: 'Could not read the MCP configuration: ',
      scanFailedHint: 'This is not an empty configuration — the loader rows were unreadable. Do not read the rows below as removed servers.',
    }

    const CSS = `
.mcp-lazy-page{max-width:760px;display:flex;flex-direction:column;gap:12px;color:var(--dsw-alias-label-primary);font:inherit}
.mcp-lazy-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}
.mcp-lazy-heading{min-width:0}
.mcp-lazy-title-row{display:flex;align-items:center;gap:8px;min-width:0}
.mcp-lazy-title{margin:0;font-size:18px;font-weight:600;line-height:26px;color:var(--dsw-alias-label-primary);font-family:inherit}
.mcp-lazy-intro{margin:4px 0 0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);font-family:inherit}
.mcp-lazy-refresh{flex:none;display:inline-flex;align-items:center;justify-content:center;width:24px;height:24px;padding:0;color:var(--dsw-alias-label-tertiary);background:transparent;border:0.5px solid transparent;border-radius:var(--dsw-radius-sm,6px);cursor:pointer;font-family:inherit}
.mcp-lazy-refresh:hover:not(:disabled){background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-primary)}
.mcp-lazy-refresh:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.mcp-lazy-refresh:disabled{opacity:.55;cursor:default}
.mcp-lazy-refresh svg{display:block;width:15px;height:15px}
.mcp-lazy-list{display:flex;flex-direction:column;gap:8px;margin:0;padding:0;list-style:none}
.mcp-lazy-card{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:12px 14px;background:var(--dsw-alias-bg-layer-1);border:0.5px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md,10px);min-width:0}
.mcp-lazy-main{min-width:0;display:flex;flex-direction:column;gap:3px}
.mcp-lazy-name{font-size:15px;font-weight:600;line-height:22px;color:var(--dsw-alias-label-primary);font-family:inherit;word-break:break-word}
.mcp-lazy-summary{font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);font-family:inherit;word-break:break-word}
.mcp-lazy-meta{display:flex;align-items:center;gap:10px;flex-shrink:0;flex-wrap:wrap;justify-content:flex-end;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary);font-family:inherit}
.mcp-lazy-count,.mcp-lazy-tokens,.mcp-lazy-connecting{white-space:nowrap}
.mcp-lazy-badge{border-radius:999px;padding:1px 8px;font-size:11px;line-height:16px;white-space:nowrap;color:var(--dsw-alias-state-error-primary);border:0.5px solid var(--dsw-alias-state-error-primary)}
.mcp-lazy-badge.warn{color:var(--dsw-alias-state-warn-primary);border-color:var(--dsw-alias-state-warn-primary)}
.mcp-lazy-switch{position:relative;flex:none;width:32px;height:18px;padding:0;border:0;border-radius:999px;background:var(--dsw-alias-border-l2);cursor:pointer;transition:background .15s ease}
.mcp-lazy-switch::after{content:"";position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-layer-1);box-shadow:0 1px 2px rgba(0,0,0,.25);transition:transform .15s ease,background .15s ease}
.mcp-lazy-switch[aria-checked="true"]{background:var(--dsw-alias-brand-primary)}
.mcp-lazy-switch[aria-checked="true"]::after{transform:translateX(14px);background:var(--dsw-alias-bg-base)}
.mcp-lazy-switch:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
.mcp-lazy-switch:disabled{opacity:.5;cursor:default}
.mcp-lazy-card.off .mcp-lazy-name{color:var(--dsw-alias-label-secondary)}
.mcp-lazy-card.off .mcp-lazy-summary{opacity:.7}
.mcp-lazy-muted,.mcp-lazy-error{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary);font-family:inherit}
.mcp-lazy-error{color:var(--dsw-alias-state-error-primary)}
.mcp-lazy-forget{padding:0 2px;background:transparent;border:0;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:18px;text-decoration:underline;text-underline-offset:2px;cursor:pointer}
.mcp-lazy-forget:hover{color:var(--dsw-alias-state-error-primary)}
.mcp-lazy-forget:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-brand-primary));outline-offset:2px}
@media (max-width:560px){.mcp-lazy-card{align-items:flex-start;flex-direction:column;gap:8px}.mcp-lazy-meta{justify-content:flex-start}}
`

    /**
     * Build the page component with the bound translator. The settings shell
     * passes its own `t` when the registration declares a locale namespace;
     * that one wins so live locale switches stay coherent.
     */
    function makePage(t) {
      function formatTokens(tokens) {
        const value = Number.isFinite(tokens) ? Math.max(0, tokens) : 0
        return value >= 1000 ? `${(value / 1000).toFixed(1)}k` : String(Math.round(value))
      }

      function McpSettingsPage(props) {
        const translate = typeof props?.t === 'function' ? props.t : t
        const [state, setState] = React.useState({ phase: 'loading', servers: [], detail: '', scan: { ok: true, error: null } })
        const [busy, setBusy] = React.useState(false)
        const [toggling, setToggling] = React.useState('')

        const refresh = React.useCallback(async () => {
          setBusy(true)
          try {
            const response = await fetch('/mcp-lazy/servers', {
              cache: 'no-store',
              headers: { accept: 'application/json' },
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            const payload = await response.json()
            const servers = Array.isArray(payload?.servers)
              ? payload.servers.filter((server) => server !== null && typeof server === 'object' && typeof server.name === 'string')
              : []
            setState({
              phase: 'ready',
              servers,
              detail: '',
              scan: payload?.scan ?? { ok: true, error: null },
            })
          } catch (error) {
            setState((previous) => ({
              ...previous,
              phase: 'error',
              servers: [],
              detail: String(error?.message ?? error),
            }))
          } finally {
            setBusy(false)
          }
        }, [])

        React.useEffect(() => {
          refresh()
        }, [refresh])

        const setServerEnabled = React.useCallback(async (name, enabled) => {
          setToggling(name)
          try {
            const response = await fetch('/mcp-lazy/toggle', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name, enabled }),
            })
            if (!response.ok) throw new Error(`HTTP ${response.status}`)
            await refresh()
          } catch (error) {
            setState((previous) => ({
              ...previous,
              phase: 'error',
              detail: String(error?.message ?? error),
            }))
          } finally {
            setToggling('')
          }
        }, [refresh])

        // A tombstone is the only thing "forget" may delete; the server refuses
        // anything still configured or still registering tools.
        const forgetServer = React.useCallback(async (name) => {
          if (typeof window.confirm === 'function' && !window.confirm(translate('forgetHint'))) return
          setToggling(name)
          try {
            const response = await fetch('/mcp-lazy/forget', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            })
            if (!response.ok) throw new Error(`${translate('forgetFailed')} (HTTP ${response.status})`)
            await refresh()
          } catch (error) {
            setState((previous) => ({
              ...previous,
              phase: 'error',
              detail: String(error?.message ?? error),
            }))
          } finally {
            setToggling('')
          }
        }, [refresh, translate])

        // Health and registry state can change while the page stays open.
        // Poll the loopback route; the interval is cleared on unmount.
        React.useEffect(() => {
          const timer = window.setInterval(() => { refresh() }, 5000)
          return () => window.clearInterval(timer)
        }, [refresh])

        const rows = state.servers.map((server) => {
          // `status` is the single lifecycle verdict from buildInventory. The
          // old code switched on `reason`, which is why every new state used to
          // need a matching change here.
          const status = typeof server.status === 'string' ? server.status : 'active'
          const reason = typeof server.reason === 'string' ? server.reason : ''
          const toolCount = Number(server.toolCount) || 0
          const enabled = server.enabled !== false
          const badges = []
          if (status === 'removed') {
            badges.push(h('span', {
              key: 'removed',
              className: 'mcp-lazy-badge',
              title: translate('missingHint'),
            }, translate('missing')))
          } else if (status === 'down') {
            const text = reason === 'call-failed'
              ? translate('callFailed')
              : reason === 'no-tools' ? translate('noTools')
                : reason === 'startup-failed' ? translate('startupFailed')
                  : reason === 'waiting-credentials' ? translate('waitingCredentials')
                    : translate('unavailable')
            badges.push(h('span', {
              key: 'down',
              className: reason === 'no-tools' ? 'mcp-lazy-badge warn' : 'mcp-lazy-badge',
            }, text))
          } else if (status === 'always-visible') {
            badges.push(h('span', { key: 'inactive', className: 'mcp-lazy-badge warn' }, translate('disclosureInactive')))
          } else if (status === 'unconfigured') {
            badges.push(h('span', {
              key: 'unconfigured',
              className: 'mcp-lazy-badge warn',
              title: translate('unconfiguredHint'),
            }, translate('unconfigured')))
          } else if (status === 'unknown') {
            badges.push(h('span', {
              key: 'unknown',
              className: 'mcp-lazy-badge',
              title: translate('unknownHint'),
            }, translate('unknown')))
          }
          if (status === 'connecting') {
            const first = server.firstConnect === true
            badges.push(h('span', {
              key: 'connecting',
              className: 'mcp-lazy-connecting',
              title: first ? translate('firstConnectHint') : undefined,
            }, translate(first ? 'firstConnect' : 'connecting')))
          }
          return h('li', {
            key: server.name,
            className: enabled ? 'mcp-lazy-card' : 'mcp-lazy-card off',
          }, [
            h('div', { key: 'main', className: 'mcp-lazy-main' }, [
              h('div', { key: 'name', className: 'mcp-lazy-name' }, server.name),
              h('div', { key: 'summary', className: 'mcp-lazy-summary' },
                typeof server.summary === 'string' && server.summary.length > 0 ? server.summary : '—'),
            ]),
            h('div', { key: 'meta', className: 'mcp-lazy-meta' }, [
              ...badges,
              h('span', { key: 'count', className: 'mcp-lazy-count' },
                `${toolCount} ${translate('tools')}`),
              toolCount > 0
                ? h('span', { key: 'tokens', className: 'mcp-lazy-tokens' },
                  `≈${formatTokens(server.tokens)} ${translate('tokens')}`)
                : null,
              status === 'removed'
                ? h('button', {
                  key: 'forget',
                  type: 'button',
                  className: 'mcp-lazy-forget',
                  title: translate('forgetHint'),
                  disabled: busy || toggling === server.name,
                  onClick: () => { forgetServer(server.name) },
                }, translate('forget'))
                : null,
              status === 'removed' || status === 'unknown'
                ? null
                : h('button', {
                  key: 'switch',
                  type: 'button',
                  role: 'switch',
                  className: 'mcp-lazy-switch',
                  'aria-checked': enabled ? 'true' : 'false',
                  'aria-label': `${server.name}: ${translate(enabled ? 'disable' : 'enable')}`,
                  title: translate(enabled ? 'disable' : 'enable'),
                  disabled: busy || toggling === server.name,
                  onClick: () => { setServerEnabled(server.name, !enabled) },
                }),
            ]),
          ])
        })

        const refreshIcon = h('svg', {
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        }, [
          h('path', { key: 'arc', d: 'M13.25 8a5.25 5.25 0 1 1-1.54-3.71' }),
          h('path', { key: 'tip', d: 'M13.25 2.6v3.3h-3.3' }),
        ])

        return h('div', { className: 'mcp-lazy-page' }, [
          h('div', { key: 'head', className: 'mcp-lazy-head' }, [
            h('div', { key: 'heading', className: 'mcp-lazy-heading' }, [
              h('div', { key: 'title-row', className: 'mcp-lazy-title-row' }, [
                h('h2', { key: 'title', className: 'mcp-lazy-title' }, translate('title')),
                h('button', {
                  key: 'refresh',
                  type: 'button',
                  className: 'mcp-lazy-refresh',
                  title: translate('refresh'),
                  'aria-label': translate('refresh'),
                  onClick: refresh,
                  disabled: busy || state.phase === 'loading',
                }, refreshIcon),
              ]),
              h('p', { key: 'intro', className: 'mcp-lazy-intro' }, translate('intro')),
            ]),
          ]),
          state.phase === 'error'
            ? h('p', { key: 'error', className: 'mcp-lazy-error', role: 'alert' },
              `${translate('error')}${state.detail === '' ? '' : ` (${state.detail})`}`)
            : null,
          state.phase === 'ready' && state.scan?.ok === false
            ? h('p', { key: 'scan', className: 'mcp-lazy-error', role: 'alert' },
              `${translate('scanFailed')}${state.scan.error ?? ''} — ${translate('scanFailedHint')}`)
            : null,
          state.phase === 'loading'
            ? h('p', { key: 'loading', className: 'mcp-lazy-muted' }, translate('loading'))
            : null,
          state.phase === 'ready' && state.servers.length === 0
            ? h('p', { key: 'empty', className: 'mcp-lazy-muted' }, translate('empty'))
            : null,
          state.phase === 'ready' && state.servers.length > 0
            ? h('ul', { key: 'list', className: 'mcp-lazy-list', role: 'list', 'aria-busy': busy ? 'true' : undefined }, rows)
            : null,
        ])
      }

      return McpSettingsPage
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'mcp-lazy: settings dictionaries')
      ctx.effect(() => {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-mcp-lazy'
        style.dataset.pluginCss = 'dsh-mcp-lazy/settings.css'
        style.textContent = CSS
        document.head.appendChild(style)
        return () => style.remove()
      }, 'mcp-lazy: settings styles')
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'mcp',
        order: 16,
        label: () => t('nav'),
        locale: NS,
      }, makePage(t)))
    }

    return { inject, apply }
  },
})
