/*
 * @Description: 侧边对话用到的宿主客户端能力（ctx.sessions 分叉 / 引用 / 改名、右侧栏打开、主区打开）—— 结构探测 + 降级
 * @Author: YangHeng
 * @Date: 2026-10-10 20:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/host.ts
 *
 * 不 import 宿主包，只按结构判断（与 tasks/host.ts 同一做法）。用到的宿主公开接口：
 * - ctx.sessions.fork({ sessionId, onCreated })：省略 atSeq = 复制到最近一个已完成轮次；子会话是普通会话，出现在左侧列表；
 * - ctx.sessions.using(id, { source }, op)：临时引用会话拿 binding.session.rename(title)（宿主 ClientSessions 自身没有 rename）；
 * - ctx.sessions.retain(id, { source, signal })：资源提供方里长期持有，交给 SessionProvider 渲染宿主会话视图；
 * - ctx.sidebarRight.openResource(address, { kind, preferNewPane })；ctx.uiWorkspace.openSession(id)（宿主「从这里分叉」后也这样打开）；
 * - ctx.uiWorkspace.archiveSession(id, { stopActivity })：删除侧边对话时从左侧工作区移除会话（宿主没有会话删除接口，见 archive）；
 * - ctx.sidebarRight.tabsIn / closeIn（控制器上的非公开方法，探测不到就跳过）：删除后关闭已打开的该侧边对话标签。
 */
import { parseSidechatAddress, primeBoundaryDraft, sideTitle, sidechatAddress } from './address.js'
import { SIDECHAT_KIND } from '../sidebar/kinds.js'
import { probeSessionList, type SessionListStore } from '../tasks/host.js'

/** 宿主 SessionReference 的最小形状。 */
export interface SessionReferenceLike {
  sessionId: string
  release(): void
  binding?: { session?: { rename?(title: string): Promise<{ ok: boolean; error?: { code?: string; message?: string } }> } }
}

export interface SessionsLike {
  fork(opts: { sessionId: string; atSeq?: number; increaseTitle?: boolean; onCreated?: (childId: string) => void }): Promise<string>
  retain(target: string, options: { source: string; signal?: AbortSignal }): SessionReferenceLike
  using?<T>(target: string, options: { source: string; signal?: AbortSignal }, operation: (reference: SessionReferenceLike) => Promise<T>): Promise<T>
  list?: SessionListStore
}

const fn = (o: unknown, key: string): boolean => typeof o === 'object' && o !== null && typeof (o as Record<string, unknown>)[key] === 'function'

/** ctx.sessions 是否具备侧边对话所需的 fork + retain。 */
export function probeSessions(svc: unknown): SessionsLike | undefined {
  return fn(svc, 'fork') && fn(svc, 'retain') ? (svc as SessionsLike) : undefined
}

/** 引用来源标签（宿主按来源统计引用计数，便于排查谁拿着会话）。 */
export const RETAIN_SOURCE = 'dshws-sidechat'

export interface SidechatHost {
  /** 宿主是否支持侧边对话（fork + retain + 右侧栏）。 */
  available(): boolean
  sessionList(): SessionListStore | undefined
  /** 分叉 → 预填边界草稿 → 改名；返回子会话 id。改名失败不影响结果（只记日志）。 */
  fork(parentId: string): Promise<string>
  openAside(childId: string, parentId?: string): boolean
  openMain(sessionId: string): boolean
  /**
   * 从左侧工作区移除会话：宿主没有公开的会话删除接口（ctx.sessions 只有 fork / retain / using 等，
   * workspaces.delete 删的是工作区登记），左侧会话列表的移除操作本身就是归档，这里用同一个接口
   * uiWorkspace.archiveSession（是当前会话时宿主会顺带清空选中），旧宿主退回 workspaces.archiveSession。
   * 会话有运行中的工作且未给 stopActivity 时宿主拒绝（见 isSessionActiveRefusal）；接口不存在或失败时抛错。
   */
  archive(sessionId: string, options?: { stopActivity?: boolean }): Promise<void>
  /** 关闭所有会话侧栏里打开着的该侧边对话标签；返回关闭的个数。 */
  closeTabsOf(childId: string): number
}

/**
 * 宿主拒绝归档「仍在运行」的会话：WorkspaceArchiveError + rpcError.code 'workspace/session-active'
 * （与宿主 dsh-client-ui-workspace 的 activeSessionRefusal 判断一致；插件与宿主不共享错误类，按 name 判断）。
 */
export function isSessionActiveRefusal(error: unknown): boolean {
  if (!(error instanceof Error) || error.name !== 'WorkspaceArchiveError') return false
  return (error as Error & { rpcError?: { code?: string } }).rpcError?.code === 'workspace/session-active'
}

interface TabRecordLike {
  id: string
  kind?: string
  contentId?: string
}

interface HostCtx {
  get(name: string): unknown
}

export function createSidechatHost(ctx: HostCtx, log: (m: string, e?: unknown) => void): SidechatHost {
  const get = (name: string): unknown => {
    try {
      return ctx.get(name)
    } catch {
      return undefined
    }
  }
  const call = (target: unknown, key: string, ...args: unknown[]): boolean => {
    if (!fn(target, key)) return false
    try {
      ;(target as Record<string, (...a: unknown[]) => unknown>)[key]!(...args)
      return true
    } catch (error) {
      log(`调用宿主 ${key} 失败`, error)
      return false
    }
  }
  const storage = (): Storage | undefined => {
    try {
      return typeof localStorage === 'undefined' ? undefined : localStorage
    } catch {
      return undefined
    }
  }
  return {
    available() {
      const right = get('sidebarRight')
      return probeSessions(get('sessions')) !== undefined && fn(right, 'openResource')
    },
    sessionList: () => probeSessionList(get('sessions')),
    async fork(parentId) {
      const sessions = probeSessions(get('sessions'))
      if (sessions === undefined) throw new Error('sessions.fork unavailable')
      const parentTitle = sessions.list?.getSnapshot().byId[parentId]?.displayTitle
      // onCreated 在子会话入列表之后、任何视图挂载之前同步回调：此时预填草稿，首次挂载就能读到（见 primeBoundaryDraft）。
      const childId = await sessions.fork({ sessionId: parentId, onCreated: (id) => primeBoundaryDraft(storage(), id) })
      const title = sideTitle(parentTitle, parentId)
      if (typeof sessions.using === 'function') {
        try {
          await sessions.using(childId, { source: RETAIN_SOURCE }, async (ref) => {
            const rename = ref.binding?.session?.rename
            if (typeof rename !== 'function') return
            const out = await rename.call(ref.binding!.session, title)
            if (!out.ok) log(`侧边对话改名失败：${out.error?.code ?? ''} ${out.error?.message ?? ''}`)
          })
        } catch (error) {
          log('侧边对话改名失败', error)
        }
      }
      return childId
    },
    openAside(childId, parentId) {
      const tabs = get('sidebarRightTabs') as { get?: (kind: string) => unknown } | undefined
      // 标签类型没注册（偏好关闭 / 宿主不支持）时 openResource 会抛「无人认领」：直接判为不支持。
      if (fn(tabs, 'get') && tabs!.get!(SIDECHAT_KIND) === undefined) return false
      return call(get('sidebarRight'), 'openResource', sidechatAddress(childId, parentId), { kind: SIDECHAT_KIND, preferNewPane: true, revealIfOpened: true })
    },
    openMain(sessionId) {
      return call(get('uiWorkspace'), 'openSession', sessionId) || call(get('sessions'), 'open', sessionId)
    },
    async archive(sessionId, options = {}) {
      const opts = options.stopActivity === true ? { stopActivity: true } : {}
      for (const name of ['uiWorkspace', 'workspaces']) {
        const svc = get(name)
        if (fn(svc, 'archiveSession')) {
          await (svc as { archiveSession(id: string, o: object): Promise<void> }).archiveSession(sessionId, opts)
          return
        }
      }
      throw new Error('archiveSession unavailable')
    },
    closeTabsOf(childId) {
      // tabsIn / closeIn 是宿主右侧栏控制器上的方法（不在 ISidebarRight 公开类型里），按结构探测；没有就不关（标签会显示「会话不存在」）。
      const right = get('sidebarRight') as { tabsIn?(sessionId: string): readonly TabRecordLike[]; closeIn?(sessionId: string, tabId: string): void } | undefined
      if (!fn(right, 'tabsIn') || !fn(right, 'closeIn')) return 0
      const ids = Object.keys(probeSessionList(get('sessions'))?.getSnapshot().byId ?? {})
      let closed = 0
      for (const sessionId of ids) {
        let tabs: readonly TabRecordLike[]
        try {
          tabs = right!.tabsIn!(sessionId)
        } catch {
          continue
        }
        for (const tab of tabs) {
          if (tab.kind !== SIDECHAT_KIND || parseSidechatAddress(tab.contentId ?? '')?.childId !== childId) continue
          if (call(right, 'closeIn', sessionId, tab.id)) closed += 1
        }
      }
      return closed
    }
  }
}
