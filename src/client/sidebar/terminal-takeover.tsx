/*
 * @Description: 远程会话的「新建终端」改开插件 SSH 终端；本机会话原样渲染宿主终端引导卡片
 * @Author: YangHeng
 * @Date: 2026-10-10 15:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/terminal-takeover.tsx
 *
 * 宿主终端（@deepseek-ai/dsh-client-ui-sidebar-terminal）把「新建终端」卡片注册在 keyed 插槽 sidebar.right.tab.guide.entry，
 * key = 它的注册 id、priority 0。插槽规则是同 key 下 priority 更低者渲染，所以本插件以 -100 注册同一个 key 接管卡片。
 *
 * 为什么本机会话能保持宿主原版：插槽没有「让给下一个占用者」的能力，且注册是全局的（不分会话）。
 * 但宿主插槽服务公开了只读台账 ctx.slots.entries(key)，里面有宿主卡片的组件与 inject。本插件注册时：
 * - inject 直接转调宿主条目的 inject（hooks.shortcuts → useShortcuts、loadShells、selectShell），locale 用宿主的命名空间；
 * - 于是渲染器交给本组件的 props 与交给宿主组件的完全相同，本机会话里本组件只是 <宿主组件 {...props} />，外观与行为就是宿主原版
 *   （Shell 列表仍由宿主服务端发现，mac / Linux / Windows 一致，不做任何平台假设）；
 * - 远程会话里也渲染宿主组件（同一套样式），只替换文案、Shell 下拉项与 tab.actions.openTab：打开 'terminal' 改为打开插件 SSH 标签。
 * 宿主卡片组件出现 / 重注册（HMR）时跟着重注册；本组件渲染崩溃时宿主插槽会让位（abdicate）回宿主卡片。
 *
 * 未覆盖的入口：Ctrl+` 快捷键（terminal.new）与其他直接 openTab('terminal') 的入口仍开宿主终端。
 * 宿主快捷键注册表对重复 id 直接抛错、没有优先级或按会话覆盖，桌面端还由原生菜单分发按键，拦截 DOM 按键不可靠；
 * 「远程会话里一出现 terminal 标签就关掉换成 SSH」会先挂载宿主终端正文、创建一个本机 PTY 再关掉，有闪烁和进程开销，
 * 所以只接管引导卡片（稳妥方案）。
 */
import { useCallback, useEffect, useState, useSyncExternalStore, type ComponentType } from 'react'
import type { ClientContext, Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import type { RemoteWorkspaceView } from '../../wire/dto.js'
import type { SidebarPrefs } from '../../wire/sidebar-prefs.js'
import { getSidebarPrefs, subscribeSidebarPrefs } from '../sidebar-prefs.js'
import type { RemoteIndex } from './remote-index.js'
import { SSH_ID } from './kinds.js'

/** 宿主右侧栏引导页的卡片插槽（keyed、会话作用域）。 */
export const GUIDE_ENTRY_SLOT = 'sidebar.right.tab.guide.entry'
/** 宿主终端的注册 id = 卡片插槽的 key。 */
export const HOST_TERMINAL_PROVIDER = '@deepseek-ai/dsh-client-ui-sidebar-terminal'
export const HOST_TERMINAL_KIND = 'terminal'
/** 宿主终端的文案命名空间（宿主条目没带 locale 时的兜底）。 */
export const HOST_TERMINAL_LOCALE = 'sidebarTerminal'
/** 比宿主（0）小即可胜出；留出余量给其他插件。 */
export const TAKEOVER_PRIORITY = -100
/** 远程会话里下拉菜单唯一一项的 id（不是 Shell 路径，不会写进宿主的 Shell 偏好）。 */
export const SSH_SHELL_ID = 'dshws-ssh'

/** 插槽台账里的一条（只声明用到的字段）。 */
export interface SlotEntryLike {
  component: ComponentType<never>
  inject?: (...args: unknown[]) => Record<string, unknown>
  locale?: string
  registrant?: string
  options: { key?: string; priority?: number }
}

interface SlotsLedger {
  entries?(name: string): readonly SlotEntryLike[]
  entriesOfSlot?(name: string): readonly SlotEntryLike[]
  subscribe?(name: string, listener: () => void): () => void
}

/** 终端入口走向：宿主终端，或连到某远程工作区的插件 SSH 终端。 */
export type TerminalRoute = { kind: 'host' } | { kind: 'ssh'; workspace: RemoteWorkspaceView }

/** 接管是否生效：需要「远程工作区使用插件 SSH 终端」开着，且 SSH 标签已注册（关掉 SSH 标签时没有可打开的目标）。 */
export function takeoverWanted(prefs: Pick<SidebarPrefs, 'remoteSshTerminal' | 'tabs'>): boolean {
  return prefs.remoteSshTerminal && prefs.tabs.ssh
}

/**
 * 引导页里插件自己的「SSH 终端」卡片是否显示：接管生效时宿主「新建终端」卡片已自适应（本机 = 宿主终端、远程 = 插件 SSH），
 * 再多一张 SSH 卡片就是重复入口；接管关闭时恢复显示，否则远程会话的用户找不到 SSH 终端入口。
 */
export function sshGuideShown(prefs: Pick<SidebarPrefs, 'remoteSshTerminal' | 'tabs'>): boolean {
  return !takeoverWanted(prefs)
}

/**
 * 注册 SSH 标签类型，并在偏好变化导致卡片显隐变化时重注册（宿主的 guide 只在注册时给定，没有显隐条件）。
 *
 * 为什么选重注册，而不是在 sidebar.right.tab.guide.entry 插槽里用同 key 的空组件盖住卡片：
 * - 宿主渲染引导页时每张卡片外面还有一层固定宽度的格子，空组件只能清空内容，格子与列表间距仍在，
 *   且「不超过 4 张卡片才显示描述」的计数仍把它算进去；重注册后卡片从 tabs.guide() 里真正消失。
 * - 已打开的 SSH 标签不受影响：宿主不会因类型撤销而关闭标签（缺类型时只临时显示「不可用」占位），
 *   正文插槽按 definition.id 取组件，id 不变；撤销与重注册在同一个同步调用里完成，React 合并为一次渲染，
 *   标签正文不会卸载重建（SSH 连接保持）。
 * register(showGuide) 负责真正注册并返回撤销函数；先撤旧再注册新（宿主对重复 id 直接抛错）。
 */
export function registerSshTabType(register: (showGuide: boolean) => () => void, log: (m: string, e?: unknown) => void): () => void {
  let shown = sshGuideShown(getSidebarPrefs())
  let off: (() => void) | undefined = register(shown)
  let disposed = false
  const sync = (): void => {
    // 偏好通知遍历的是监听器快照：本函数被撤销后仍可能收到这一轮通知，不能再注册。
    if (disposed) return
    const next = sshGuideShown(getSidebarPrefs())
    if (next === shown) return
    shown = next
    const dispose = off
    off = undefined
    try {
      dispose?.()
      off = register(next)
    } catch (error) {
      log('重新注册「SSH 终端」标签失败', error)
    }
  }
  const offPrefs = subscribeSidebarPrefs(sync)
  return () => {
    disposed = true
    offPrefs()
    const dispose = off
    off = undefined
    dispose?.()
  }
}

/** 某会话的终端走向：只有远程工作区会话才改走 SSH，其余（本机会话、工作区列表未加载完）一律宿主终端。 */
export function terminalRoute(enabled: boolean, workspace: RemoteWorkspaceView | undefined): TerminalRoute {
  return enabled && workspace !== undefined ? { kind: 'ssh', workspace } : { kind: 'host' }
}

/** 插件 SSH 标签的导航参数。 */
export interface SshNavParams {
  hostId?: string
  /** 远程初始目录（绝对路径）。 */
  cwd?: string
  title?: string
}

const ID_MAX = 200
const PATH_MAX = 4096

/** 从标签导航参数里取 SSH 目标；字段非法（类型、长度、相对路径）的一律丢弃，交给调用方回退到当前工作区。 */
export function parseSshParams(params: unknown): SshNavParams {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return {}
  const p = params as Record<string, unknown>
  const out: SshNavParams = {}
  if (typeof p.hostId === 'string' && p.hostId.trim() !== '' && p.hostId.length <= ID_MAX) out.hostId = p.hostId
  if (typeof p.cwd === 'string' && p.cwd.startsWith('/') && p.cwd.length <= PATH_MAX) out.cwd = p.cwd
  if (typeof p.title === 'string' && p.title.trim() !== '' && p.title.length <= ID_MAX) out.title = p.title
  return out
}

/** 远程工作区 → 打开 SSH 标签时带的参数（主机 + 工作区目录）。 */
export function sshParamsFor(workspace: RemoteWorkspaceView): SshNavParams {
  return { hostId: workspace.hostId, cwd: workspace.remotePath, title: workspace.title }
}

/**
 * SSH 标签要连的目标：导航参数里有 hostId 就用它（cwd / title 可选）；否则用当前会话的远程工作区；
 * 都没有（本机会话且未指定主机）返回 undefined，由标签显示「不是远程工作区」的提示。
 */
export function sshTarget(params: SshNavParams, workspace: RemoteWorkspaceView | undefined): { hostId: string; cwd?: string; title?: string } | undefined {
  if (params.hostId !== undefined) {
    const sameHost = workspace !== undefined && workspace.hostId === params.hostId
    const cwd = params.cwd ?? (sameHost ? workspace.remotePath : undefined)
    const title = params.title ?? (sameHost ? workspace.title : undefined)
    return { hostId: params.hostId, ...(cwd !== undefined ? { cwd } : {}), ...(title !== undefined ? { title } : {}) }
  }
  if (workspace === undefined) return undefined
  return { hostId: workspace.hostId, cwd: workspace.remotePath, title: workspace.title }
}

/** 台账里「没有本插件时会渲染」的宿主卡片：同 key、按 priority 升序（台账已排好）的第一个非本插件条目。 */
export function findHostGuide(entries: readonly SlotEntryLike[], self: unknown): SlotEntryLike | undefined {
  return entries.find((e) => e.options.key === HOST_TERMINAL_PROVIDER && e.component !== self)
}

/** 远程会话卡片的文案（参数名用 t，便于文案完整性测试静态检查键名）。 */
export function sshGuideCopy(t: Translate, workspace: RemoteWorkspaceView, hostLabel: string | undefined): { title: string; description: string; shell: string } {
  const host = hostLabel ?? workspace.title
  return {
    title: t('termTakeover.title', { host }),
    description: t('termTakeover.desc', { path: workspace.remotePath }),
    shell: t('termTakeover.shell', { host })
  }
}

// ---------------------------------------------------------------- 主机名（卡片文案用）

const LABEL_TTL = 60_000
const labelCache = new Map<string, { at: number; value: Promise<string | undefined> }>()

/** 主机显示名：保险箱里的主机名称，没有就 hostname；取不到（保险箱锁着、接口失败）返回 undefined。 */
function hostLabelOf(api: WorkspaceApi, hostId: string): Promise<string | undefined> {
  const hit = labelCache.get(hostId)
  if (hit !== undefined && Date.now() - hit.at < LABEL_TTL) return hit.value
  const value = api
    .call('state', {})
    .then((s) => {
      const h = s.hosts.find((x) => x.id === hostId)
      if (h === undefined) return undefined
      return typeof h.label === 'string' && h.label.trim() !== '' ? h.label : h.hostname
    })
    .catch(() => undefined)
  labelCache.set(hostId, { at: Date.now(), value })
  return value
}

// ---------------------------------------------------------------- 卡片组件

interface TabInfoLike {
  tab: { actions: { openTab(kind: string, options?: { replaceTab?: boolean; params?: unknown }): void } } & Record<string, unknown>
}

interface ShellChoices {
  shells: Array<{ path: string; name: string }>
  selectedShell?: string
}

interface TakeoverInjected {
  host: SlotEntryLike
  index: RemoteIndex
  api: WorkspaceApi
  t: Translate
  sessionId: string
}

interface GuideProps {
  title: string
  description?: string
  useTabInfo(): TabInfoLike
  useShortcuts(selector: (entries: unknown[]) => unknown): unknown
  loadShells(signal: AbortSignal): Promise<ShellChoices>
  selectShell(path: string): void
  dshws: TakeoverInjected
  [prop: string]: unknown
}

/** 订阅某会话的远程工作区（列表异步加载完 / 新建工作区后会变）。 */
function useWorkspace(index: RemoteIndex, sessionId: string): RemoteWorkspaceView | undefined {
  const subscribe = useCallback((l: () => void) => index.subscribe(l), [index])
  return useSyncExternalStore(subscribe, () => index.bySession(sessionId), () => index.bySession(sessionId))
}

function useHostLabel(api: WorkspaceApi, hostId: string | undefined): string | undefined {
  const [label, setLabel] = useState<{ hostId: string; value: string | undefined } | undefined>(undefined)
  useEffect(() => {
    if (hostId === undefined) return
    let alive = true
    void hostLabelOf(api, hostId).then((value) => alive && setLabel({ hostId, value }))
    return () => {
      alive = false
    }
  }, [api, hostId])
  return label !== undefined && label.hostId === hostId ? label.value : undefined
}

/**
 * 接管后的「新建终端」卡片。两种会话都渲染宿主卡片组件本身（同一个组件类型，切换时 React 保留其状态、样式完全一致）：
 * 本机会话原样透传；远程会话替换文案 / 下拉项 / 打开目标，并隐藏快捷键提示（Ctrl+` 仍开宿主终端，显示在 SSH 卡片上会误导）。
 */
export function TerminalGuideOverride(props: GuideProps) {
  const { dshws, ...rest } = props
  const Host = dshws.host.component as unknown as ComponentType<Record<string, unknown>>
  const workspace = useWorkspace(dshws.index, dshws.sessionId)
  const hostLabel = useHostLabel(dshws.api, workspace?.hostId)
  const route = terminalRoute(true, workspace)
  const copy = route.kind === 'ssh' ? sshGuideCopy(dshws.t, route.workspace, hostLabel) : undefined
  const shellName = copy?.shell
  // 宿主卡片的读取 effect 依赖 loadShells 的引用：必须稳定，否则菜单打开时每次渲染都会重新读取。
  const loadSsh = useCallback(async (): Promise<ShellChoices> => ({ shells: [{ path: SSH_SHELL_ID, name: shellName ?? '' }], selectedShell: SSH_SHELL_ID }), [shellName])
  if (route.kind === 'host' || copy === undefined) return <Host {...rest} />
  const params = sshParamsFor(route.workspace)
  const useTabInfo = (): TabInfoLike => {
    const info = rest.useTabInfo()
    const openTab = info.tab.actions.openTab
    return {
      ...info,
      tab: {
        ...info.tab,
        actions: {
          ...info.tab.actions,
          openTab: (kind, options) =>
            kind === HOST_TERMINAL_KIND ? openTab(SSH_ID, { replaceTab: options?.replaceTab ?? true, params }) : openTab(kind, options)
        }
      }
    }
  }
  const useShortcuts = (selector: (entries: unknown[]) => unknown): unknown => {
    // 照常订阅（保持宿主组件的 Hook 顺序不变），但不显示快捷键。
    rest.useShortcuts(selector)
    return undefined
  }
  return (
    <Host
      {...rest}
      title={copy.title}
      {...(rest.description !== undefined ? { description: copy.description } : {})}
      useTabInfo={useTabInfo}
      useShortcuts={useShortcuts}
      loadShells={loadSsh}
      selectShell={() => undefined}
    />
  )
}

// ---------------------------------------------------------------- 注册

export interface TerminalTakeoverDeps {
  t: Translate
  api: WorkspaceApi
  index: RemoteIndex
}

/**
 * 按偏好接管 / 撤销「新建终端」卡片。注册失败一律只记日志（宿主会把注册回调里的异常吞成微任务错误，症状只是接管静默失效），
 * 注册后自检插槽胜出者是不是本插件，被更低 priority 的其他插件占住时记日志。
 */
export function registerTerminalTakeover(ctx: ClientContext, deps: TerminalTakeoverDeps, log: (m: string, e?: unknown) => void): () => void {
  const ledger = ctx.slots as unknown as SlotsLedger
  if (typeof ledger.entries !== 'function' || typeof ledger.subscribe !== 'function') {
    log('宿主插槽服务不支持读取占用者（ctx.slots.entries / subscribe），跳过终端入口接管')
    return () => undefined
  }
  const entries = (): readonly SlotEntryLike[] => ledger.entries?.(GUIDE_ENTRY_SLOT) ?? []

  /** 插槽声明期间：跟随宿主卡片条目注册 / 重注册本插件的覆盖条目。 */
  const mount = (): (() => void) => {
    let off: (() => void) | undefined
    let bound: SlotEntryLike | undefined
    const reconcile = (): void => {
      const host = findHostGuide(entries(), TerminalGuideOverride)
      if (host === bound) return
      const dispose = off
      off = undefined
      bound = host
      dispose?.()
      if (host === undefined) return
      const inject = (...args: unknown[]): Record<string, unknown> => {
        const sessionId = typeof args[0] === 'string' ? args[0] : ''
        const face = host.inject?.(...args) ?? {}
        return { ...face, dshws: { host, index: deps.index, api: deps.api, t: deps.t, sessionId } satisfies TakeoverInjected }
      }
      off = ctx.slots.register(
        { name: GUIDE_ENTRY_SLOT, key: HOST_TERMINAL_PROVIDER, priority: TAKEOVER_PRIORITY, locale: host.locale ?? HOST_TERMINAL_LOCALE, inject: inject as never },
        TerminalGuideOverride as never
      )
      const head = ledger.entriesOfSlot?.(GUIDE_ENTRY_SLOT).find((e) => e.options.key === HOST_TERMINAL_PROVIDER)
      if (head !== undefined && head.component !== TerminalGuideOverride) {
        log(`「新建终端」卡片已被更高优先级的注册占用（${head.registrant ?? 'unknown'}），远程会话的 SSH 接管不会生效`)
      }
    }
    const safeReconcile = (): void => {
      try {
        reconcile()
      } catch (error) {
        log('接管「新建终端」卡片失败', error)
      }
    }
    safeReconcile()
    const unsubscribe = ledger.subscribe?.(GUIDE_ENTRY_SLOT, safeReconcile) ?? (() => undefined)
    return () => {
      unsubscribe()
      const dispose = off
      off = undefined
      bound = undefined
      try {
        dispose?.()
      } catch (error) {
        log('撤销「新建终端」卡片接管失败', error)
      }
    }
  }

  let offInject: (() => void) | undefined
  const sync = (): void => {
    const want = takeoverWanted(getSidebarPrefs())
    if (want && offInject === undefined) {
      try {
        offInject = ctx.slots.inject(GUIDE_ENTRY_SLOT, mount)
      } catch (error) {
        log('接管「新建终端」卡片失败', error)
      }
    } else if (!want && offInject !== undefined) {
      const dispose = offInject
      offInject = undefined
      try {
        dispose()
      } catch (error) {
        log('撤销「新建终端」卡片接管失败', error)
      }
    }
  }
  sync()
  const offPrefs = subscribeSidebarPrefs(sync)
  return () => {
    offPrefs()
    const dispose = offInject
    offInject = undefined
    dispose?.()
  }
}
