/*
 * @Description: 右侧栏「SSH 终端」标签 —— 默认连到当前远程工作区的主机、初始目录为工作区根；导航参数可指定主机
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/SshTab.tsx
 *
 * 导航参数（sidebarRight.openTab / tab.actions.openTab 的 params）：{ hostId?, cwd?, title? }，见 terminal-takeover.tsx 的 parseSshParams。
 * 远程会话里「新建终端」卡片就是带着当前工作区的 hostId + cwd 打开本标签；没有 hostId 时回退到当前远程工作区，
 * 本机会话又没指定主机时保持原来的「不是远程工作区」提示。
 */
import { useEffect, useState } from 'react'
import { TerminalView } from '../terminal/TerminalView.js'
import type { SidebarBodyProps, SidebarTabInfo } from './RemoteFileTab.js'
import { parseSshParams, sshTarget } from './terminal-takeover.js'

/**
 * 右侧栏标签 id → 宿主终端 id。标签隐藏 / 切换时组件会卸载重挂，
 * 终端本身留在宿主（输出整段回放），所以按标签 id 复用同一个终端，而不是每次重开。
 */
const terminalsByTab = new Map<string, Promise<string>>()

export function SshTab(props: SidebarBodyProps) {
  const { t, api, index, sessionId } = props
  // SSH 标签只注册在右侧栏，一定有标签信息。
  const info = (props.useTabInfo as () => SidebarTabInfo)()
  const [, setVersion] = useState(0)
  useEffect(() => index.subscribe(() => setVersion((v) => v + 1)), [index])
  const target = sshTarget(parseSshParams(info.tab.navigation?.params), index.bySession(sessionId))
  const hostId = target?.hostId
  const cwd = target?.cwd
  const title = target?.title
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (hostId === undefined) return
    const key = `${info.tab.id}#${nonce}`
    let pending = terminalsByTab.get(key)
    if (pending === undefined) {
      pending = api
        .call('openTerminal', { hostId, cols: 100, rows: 30, ...(cwd !== undefined ? { cwd } : {}), ...(title !== undefined ? { title } : {}) })
        .then((view) => view.id)
      terminalsByTab.set(key, pending)
      pending.catch(() => terminalsByTab.delete(key))
    }
    let alive = true
    pending.then(
      (id) => alive && setTerminalId(id),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      alive = false
    }
  }, [api, info.tab.id, nonce, hostId, cwd, title])

  if (hostId === undefined) return <div className="dshws-side-note">{t('side.notRemote')}</div>
  if (error !== null) {
    return (
      <div className="dshws-side-note" data-tone="error">
        {error}
        <button type="button" className="dshws-link-btn" onClick={() => { setError(null); setNonce((n) => n + 1) }}>
          {t('term.menuReconnect')}
        </button>
      </div>
    )
  }
  if (terminalId === null) return <div className="dshws-side-note">{t('term.connecting')}</div>
  return (
    <div className="dshws-side dshws-side-term">
      <TerminalView
        key={terminalId}
        t={t}
        terminalId={terminalId}
        active={info.tab.visible !== false}
        scrollback={5000}
        exited={exited}
        onStatus={(s) => setExited(s.status === 'exited')}
        onRestart={() => {
          setExited(false)
          setTerminalId(null)
          setNonce((n) => n + 1)
        }}
      />
    </div>
  )
}
