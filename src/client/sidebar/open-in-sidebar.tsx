/*
 * @Description: 侧栏打开入口（浏览器端）—— open_in_sidebar 工具卡片的执行与渲染 + 对外客户端服务 dshWorkspace
 * @Author: YangHeng
 * @Date: 2026-10-10 16:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/open-in-sidebar.tsx
 *
 * 为什么在工具卡片里执行「打开」：宿主没有宿主 → 浏览器的推送通道，工具在宿主端执行完只能把结果写进会话；
 * 浏览器端的 tool.call.toolview 插槽（key = 工具名）能看到这次调用的状态变化，结果 ok 时在侧栏打开。
 * 限制：只有当前显示该会话的页面会打开（方案 3.6）。
 *
 * 去重（历史重放不重复打开）：只有「本页亲眼看到过它在进行中」的调用，在变成 ok 时才打开，且每个 callId 只打开一次。
 * 已打开的 callId 同时记在模块级 Set 与 sessionStorage（插件热重载后模块状态丢失也不重复）。
 */
import { useEffect, useMemo, useState } from 'react'
import type { ClientContext, Translate } from '../context.js'
import {
  BS_OPEN_TOOL_NAME,
  OPEN_TOOL_NAME,
  isHttpUrl,
  parseOpenResult,
  type OpenValue
} from '../../wire/open-in-sidebar.js'
import { getSidebarPrefs, subscribeSidebarPrefs } from '../sidebar-prefs.js'
import {
  displayPath,
  localFileAddress,
  localSessionAddress,
  normalizePosix,
  sessionFileAddress,
  toLocalPosix,
  toRemotePath,
  type RemoteIndex
} from './remote-index.js'
import { BROWSER_KIND, GIT_ID, SIDECHAT_KIND, SSH_ID, TASKS_KIND } from './kinds.js'

// ------------------------------------------------------------------ 去重

/** 工具卡片看到的调用状态。 */
export type CallState = 'running' | 'ok' | 'error' | 'stopped'

export interface CallDedupe {
  /** 报告一次状态；返回 true = 这一次应当执行打开。 */
  observe(callId: string, state: CallState): boolean
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

const HANDLED_KEY = 'dshws.openInSidebar.handled'
/** sessionStorage 里最多记多少个已处理的 callId（只是防重，不必永久）。 */
const HANDLED_MAX = 200

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/**
 * 去重器：
 * - 进行中（含参数生成中）→ 记为「本页看到过的实时调用」；
 * - 变成 ok → 只有看到过进行中、且没处理过，才返回 true（并记为已处理）；
 * - 一挂载就是 ok（历史重放、切回会话）→ 永远不打开。
 */
export function createCallDedupe(storage: StorageLike | undefined = defaultStorage()): CallDedupe {
  const live = new Set<string>()
  const handled = new Set<string>()
  const read = (): string[] => {
    try {
      const raw = JSON.parse(storage?.getItem(HANDLED_KEY) ?? '[]') as unknown
      return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string') : []
    } catch {
      return []
    }
  }
  const persist = (callId: string): void => {
    try {
      const list = read().filter((x) => x !== callId)
      list.push(callId)
      storage?.setItem(HANDLED_KEY, JSON.stringify(list.slice(-HANDLED_MAX)))
    } catch {
      /* 存储不可用（隐私模式 / 配额）：只靠模块级 Set */
    }
  }
  return {
    observe(callId, state) {
      if (callId === '') return false
      if (state === 'running') {
        live.add(callId)
        return false
      }
      const wasLive = live.delete(callId)
      if (state !== 'ok' || !wasLive) return false
      if (handled.has(callId) || read().includes(callId)) return false
      handled.add(callId)
      persist(callId)
      return true
    }
  }
}

/** 页内唯一：同一调用在多个视图里出现（主区 + 子代理查看器）也只打开一次。 */
const sharedDedupe = createCallDedupe()

// ------------------------------------------------------------------ 打开器

export type OpenFileMode = 'preview' | 'edit'
export type WorkspaceTabKind = 'files' | 'git' | 'ssh' | 'tasks' | 'sidechat'

export interface OpenFileOptions {
  /** 打开后定位到的行（1 起）；会切到代码视图。 */
  line?: number
  mode?: OpenFileMode
  /** 路径所属会话（相对路径的基准、远程 / 本机的判断依据）；缺省 = 当前显示的会话。 */
  sessionId?: string
}

/** 对外客户端服务（ctx.get('dshWorkspace')）。方法返回 true = 已交给侧栏打开。 */
export interface DshWorkspaceService {
  openFile(path: string, options?: OpenFileOptions): boolean
  openTab(kind: WorkspaceTabKind): boolean
  reveal(path: string, options?: { sessionId?: string }): boolean
}

export interface SidebarOpener extends DshWorkspaceService {
  openUrl(url: string): boolean
  /** 执行一次 open_in_sidebar 的结果。 */
  openResult(value: OpenValue): boolean
}

interface SidebarRightLike {
  openResource?(address: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
  openTab?(kind: string, options?: { params?: unknown; revealIfOpened?: boolean }): void
}

export interface OpenerDeps {
  index: Pick<RemoteIndex, 'bySession' | 'sessionCwd'>
  right(): SidebarRightLike | undefined
  /** 该 kind 的标签是否已注册（未注册时 openTab 什么都不会发生，返回 false 让调用方知道）。 */
  hasKind(kind: string): boolean
  /** 当前显示的会话。 */
  currentSession(): string | undefined
  /** 文件管理的 kind（接管了宿主「文件」侧栏时是 files）。 */
  filesKind(): string
  now?(): number
}

type Where = 'auto' | 'local' | 'remote'

function isAbsoluteLocal(p: string): boolean {
  return p.startsWith('/') || /^[A-Za-z]:\//.test(p)
}

/**
 * 路径 → 本机路径（本地 POSIX 形式）。相对路径按会话 cwd 拼接；无法确定时返回 undefined。
 * UNC（//server/share）不支持：本插件的查看器不认领，返回 undefined 交还调用方。
 */
function localPosixOf(input: string, cwd: string | undefined): string | undefined {
  const p = input.replace(/\\/g, '/')
  if (p.startsWith('//')) return undefined
  if (isAbsoluteLocal(p)) return normalizePosix(toLocalPosix(p))
  if (cwd === undefined || cwd === '') return undefined
  return normalizePosix(toLocalPosix(`${cwd.replace(/\\/g, '/').replace(/\/+$/, '')}/${p}`))
}

/**
 * 文件路径 → 侧栏资源地址（规则与文件树 / 聊天链接一致，右栏按地址去重）。
 * - 远程工作区会话：远程路径 → 会话范围地址；盘符等本机路径 → absolute 地址（不归远程会话）。
 * - 本机会话：localSessionAddress（工作区内相对、工作区外绝对）。
 * - 没有会话：只接受绝对路径。
 */
export function fileAddressOf(index: OpenerDeps['index'], sessionId: string | undefined, input: string, where: Where = 'auto'): string | undefined {
  const ws = sessionId === undefined ? undefined : index.bySession(sessionId)
  if (ws !== undefined && sessionId !== undefined) {
    if (where !== 'local') {
      const remote = toRemotePath(ws, input)
      if (remote !== undefined) return sessionFileAddress(sessionId, remote)
      if (where === 'remote') return undefined
    }
    const local = localPosixOf(input, undefined)
    return local === undefined ? undefined : localFileAddress(local)
  }
  if (where === 'remote') return undefined
  if (sessionId === undefined) {
    const local = localPosixOf(input, undefined)
    return local === undefined ? undefined : localFileAddress(local)
  }
  const cwd = index.sessionCwd(sessionId)
  const local = localPosixOf(input, cwd)
  return local === undefined ? undefined : localSessionAddress(sessionId, cwd, local)
}

/** 「文件管理」定位用的路径（文件树里的写法：远程绝对路径 / 本地 POSIX 形式）。 */
export function revealPathOf(index: OpenerDeps['index'], sessionId: string, input: string, where: Where = 'auto'): string | undefined {
  const ws = index.bySession(sessionId)
  if (ws !== undefined) return where === 'local' ? undefined : toRemotePath(ws, input)
  if (where === 'remote') return undefined
  return localPosixOf(input, index.sessionCwd(sessionId))
}

export function createSidebarOpener(deps: OpenerDeps): SidebarOpener {
  const now = deps.now ?? Date.now
  const openTabKind = (kind: string, params?: Record<string, unknown>): boolean => {
    const right = deps.right()
    if (typeof right?.openTab !== 'function' || !deps.hasKind(kind)) return false
    right.openTab(kind, { ...(params !== undefined ? { params } : {}), revealIfOpened: true })
    return true
  }
  const openAddress = (address: string | undefined, params?: Record<string, unknown>): boolean => {
    const right = deps.right()
    if (address === undefined || typeof right?.openResource !== 'function') return false
    right.openResource(address, { revealIfOpened: true, ...(params !== undefined ? { params } : {}) })
    return true
  }
  const fileParams = (options: OpenFileOptions | undefined): Record<string, unknown> | undefined => {
    const line = options?.line
    const params: Record<string, unknown> = {}
    if (typeof line === 'number' && Number.isInteger(line) && line > 0) params.line = line
    if (options?.mode === 'preview' || options?.mode === 'edit') params.mode = options.mode
    // nonce：同一文件再次带参数打开时，查看器据此判断是新的导航（旧宿主没有 navigation.revision）。
    return Object.keys(params).length === 0 ? undefined : { ...params, nonce: now() }
  }
  const revealIn = (sessionId: string | undefined, input: string, where: Where, expand: boolean): boolean => {
    if (sessionId === undefined) return false
    const target = revealPathOf(deps.index, sessionId, input, where)
    if (target === undefined) return false
    // 定位是否已处理按宿主导航 revision 判断（见 RemoteFilesTab）；nonce 供没有 revision 的旧宿主兜底。
    return openTabKind(deps.filesKind(), { reveal: target, ...(expand ? { expand: true } : {}), nonce: now() })
  }

  return {
    openFile(path, options) {
      const sessionId = options?.sessionId ?? deps.currentSession()
      return openAddress(fileAddressOf(deps.index, sessionId, path), fileParams(options))
    },
    openTab(kind) {
      switch (kind) {
        case 'files':
          return openTabKind(deps.filesKind())
        case 'git':
          return openTabKind(GIT_ID)
        case 'ssh':
          return openTabKind(SSH_ID)
        // 任务页 / 侧边对话：标签被偏好关闭（未注册）时 hasKind 为 false，返回 false。侧边对话无参数打开 = 当前会话的线程列表。
        case 'tasks':
          return openTabKind(TASKS_KIND)
        case 'sidechat':
          return openTabKind(SIDECHAT_KIND)
        default:
          return false
      }
    },
    reveal(path, options) {
      return revealIn(options?.sessionId ?? deps.currentSession(), path, 'auto', false)
    },
    openUrl(url) {
      if (!isHttpUrl(url)) return false
      return openTabKind(BROWSER_KIND, { url })
    },
    openResult(value) {
      const sessionId = deps.currentSession()
      // 宿主已判定远程 / 本机：按它的结论走，不再按 / 开头猜（macOS / Linux 宿主上本机路径也是 / 开头）。
      const where: Where = value.remoteHost !== undefined ? 'remote' : 'local'
      if (value.remoteHost !== undefined) {
        // 远程目标只能在同一台主机的远程工作区会话里打开（地址按当前会话解析）。
        const ws = sessionId === undefined ? undefined : deps.index.bySession(sessionId)
        if (ws === undefined || ws.hostId !== value.remoteHost) return false
      }
      switch (value.kind) {
        case 'url':
          return isHttpUrl(value.target) && openTabKind(BROWSER_KIND, { url: value.target })
        case 'folder':
          return revealIn(sessionId, value.target, where, true)
        default:
          return openAddress(fileAddressOf(deps.index, sessionId, value.target, where))
      }
    }
  }
}

// ------------------------------------------------------------------ 客户端服务（ctx.provide('dshWorkspace')）

let currentOpener: SidebarOpener | undefined

/** 右侧栏接入完成后设置真正的打开器；返回撤销函数（只撤自己设置的那个）。 */
export function setWorkspaceOpener(opener: SidebarOpener): () => void {
  currentOpener = opener
  return () => {
    if (currentOpener === opener) currentOpener = undefined
  }
}

/**
 * 对外服务对象：在插件入口就 provide（早于右侧栏接入），方法调用时转给当前打开器；
 * 右侧栏还没接入（或宿主不支持）时返回 false，而不是抛错。
 */
export const workspaceService: DshWorkspaceService = Object.freeze({
  openFile: (path: string, options?: OpenFileOptions) => currentOpener?.openFile(path, options) ?? false,
  openTab: (kind: WorkspaceTabKind) => currentOpener?.openTab(kind) ?? false,
  reveal: (path: string, options?: { sessionId?: string }) => currentOpener?.reveal(path, options) ?? false
})

// ------------------------------------------------------------------ 工具卡片

interface ToolBlockLike {
  callId?: string
  name?: string
  argsRaw?: string
  kind?: string
  call?: { name?: string; argsRaw?: string }
  content?: Array<{ type?: string; text?: string }>
  isError?: boolean
  error?: { name?: string; code?: string }
}

export interface OpenToolRowProps {
  callId?: string
  toolName?: string
  phase?: 'preparing' | 'start' | 'result'
  block: ToolBlockLike
  t: Translate
  opener: () => SidebarOpener | undefined
}

/** 卡片状态（纯函数，便于单测）。 */
export function rowStateOf(phase: OpenToolRowProps['phase'], block: ToolBlockLike): CallState {
  const settled = phase === 'result' || (block !== null && typeof block === 'object' && 'kind' in block)
  if (!settled) return 'running'
  if (block.error?.code === 'interrupted') return 'stopped'
  return block.isError === true ? 'error' : 'ok'
}

/** 解析参数（生成中的参数可能是不完整的 JSON：解析失败时用正则兜底取 target）。 */
export function targetOfArgs(argsRaw: string | undefined): string | undefined {
  if (argsRaw === undefined || argsRaw === '') return undefined
  try {
    const parsed = JSON.parse(argsRaw) as { target?: unknown }
    return typeof parsed.target === 'string' ? parsed.target : undefined
  } catch {
    const m = /"target"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(argsRaw)
    if (m === null) return undefined
    try {
      return JSON.parse(`"${m[1] as string}"`) as string
    } catch {
      return m[1]
    }
  }
}

function resultText(block: ToolBlockLike): string {
  return (block.content ?? []).map((item) => (item.type === 'text' ? item.text ?? '' : '')).join('\n')
}

type Outcome = 'opened' | 'unavailable' | null

function OpenGlyph() {
  return (
    <svg width={14} height={14} viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.3" />
      <path d="M10 2.5v11" stroke="currentColor" strokeWidth="1.3" />
    </svg>
  )
}

/** open_in_sidebar（及被遮蔽的 sidebar_open）的工具卡片：自动打开 + 简洁卡片 +「再次打开」。 */
export function OpenToolRow(props: OpenToolRowProps) {
  const { t, block } = props
  const callId = props.callId ?? block.callId ?? ''
  const state = rowStateOf(props.phase, block)
  const argsRaw = state === 'running' ? block.argsRaw : block.call?.argsRaw ?? block.argsRaw
  const text = state === 'running' ? '' : resultText(block)
  const value = useMemo(() => (state === 'ok' ? parseOpenResult(text) : undefined), [state, text])
  const target = value?.target ?? targetOfArgs(argsRaw)
  const [outcome, setOutcome] = useState<Outcome>(null)

  useEffect(() => {
    if (!sharedDedupe.observe(callId, state) || value === undefined) return
    const ok = props.opener()?.openResult(value) ?? false
    setOutcome(ok ? 'opened' : 'unavailable')
    // value 由 state + text 决定，依赖它们即可
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [callId, state, value])

  const reopen = (): void => {
    const opener = props.opener()
    if (opener === undefined || target === undefined) return
    let ok: boolean
    if (value !== undefined) ok = opener.openResult(value)
    // 旧格式结果（BS 的 sidebar_open）：只有参数，网址 / 路径按当前会话解析。
    else ok = isHttpUrl(target) ? opener.openUrl(target) : opener.openFile(target)
    setOutcome(ok ? 'opened' : 'unavailable')
  }

  const kindLabel =
    value?.kind === 'url' ? t('oisb.kindUrl') : value?.kind === 'folder' ? t('oisb.kindFolder') : value?.kind === 'file' ? t('oisb.kindFile') : ''
  let status: string
  if (state === 'running') status = t('oisb.running')
  else if (state === 'stopped') status = t('oisb.stopped')
  else if (state === 'error') status = t('oisb.failed')
  else if (outcome === 'opened') status = t('oisb.opened')
  else if (outcome === 'unavailable') status = t('oisb.unavailable')
  else status = t('oisb.requested')
  const errorLine = state === 'error' ? (text.split('\n').find((l) => l.trim() !== '') ?? '') : ''
  const shown = target === undefined ? '' : value?.kind === 'url' ? target : displayPath(target)

  return (
    <div className="dshws-oisb" data-tool={props.toolName ?? OPEN_TOOL_NAME} data-state={state}>
      <div className="dshws-oisb-row">
        <span className="dshws-oisb-icon">
          <OpenGlyph />
        </span>
        <span className="dshws-oisb-title">{t('oisb.title')}</span>
        {kindLabel !== '' ? <span className="dshws-oisb-kind">{kindLabel}</span> : null}
        <span className="dshws-oisb-target" title={shown}>
          {value?.title !== undefined && value.title !== shown ? `${value.title} · ${shown}` : shown}
        </span>
        <span className="dshws-oisb-status">{status}</span>
        {state === 'ok' && target !== undefined ? (
          <button type="button" className="dshws-oisb-btn" onClick={reopen}>
            {t('oisb.reopen')}
          </button>
        ) : null}
      </div>
      {errorLine !== '' ? <div className="dshws-oisb-error">{errorLine}</div> : null}
    </div>
  )
}

// ------------------------------------------------------------------ 注册

const TOOLVIEW_SLOT = 'tool.call.toolview'
/** 同 key 同 priority 冲突时让位重试的 priority（keyed 插槽 lowest renders）。 */
const FALLBACK_PRIORITY = -10

/**
 * 注册 open_in_sidebar 与 sidebar_open 两个 key 的工具卡片，受偏好 openInSidebar 控制（切换即时生效）。
 * 同 key 同 priority 已被占用（BS 或别的插件也注册了卡片）时宿主会抛错：退到更小的 priority 取胜，仍失败只记日志。
 */
export function registerOpenToolViews(
  ctx: ClientContext,
  deps: { t: Translate; opener: () => SidebarOpener | undefined },
  log: (message: string, error?: unknown) => void
): () => void {
  const inject = () => ({ t: deps.t, opener: deps.opener })
  const registerKey = (key: string): (() => void) => {
    try {
      return ctx.slots.inject(TOOLVIEW_SLOT, () => {
        try {
          return ctx.slots.register({ name: TOOLVIEW_SLOT, key, inject }, OpenToolRow as never)
        } catch {
          try {
            return ctx.slots.register({ name: TOOLVIEW_SLOT, key, priority: FALLBACK_PRIORITY, inject }, OpenToolRow as never)
          } catch (error) {
            log(`注册工具卡片「${key}」失败`, error)
            return () => undefined
          }
        }
      })
    } catch (error) {
      log(`注入工具卡片插槽失败（${key}）`, error)
      return () => undefined
    }
  }
  let off: (() => void) | undefined
  const sync = (): void => {
    const on = getSidebarPrefs().openInSidebar
    if (on && off === undefined) {
      const a = registerKey(OPEN_TOOL_NAME)
      // 被遮蔽后的同名 sidebar_open 调用（restrict 不可用时以同一实现注册）也用本卡片执行。
      const b = registerKey(BS_OPEN_TOOL_NAME)
      off = () => {
        b()
        a()
      }
    } else if (!on && off !== undefined) {
      off()
      off = undefined
    }
  }
  sync()
  const unsubscribe = subscribeSidebarPrefs(sync)
  return () => {
    unsubscribe()
    off?.()
    off = undefined
  }
}
