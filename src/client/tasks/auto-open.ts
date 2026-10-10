/*
 * @Description: 新子代理 / 新后台任务出现时自动打开任务页（偏好 tasksAutoOpen；窄屏不开；每个新对象只触发一次；尊重手动关闭）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/auto-open.ts
 *
 * 判定「新」：
 * 1. 只看显示中的会话自己产生的对象 —— 它目录里的直接子代理、owner 是它的后台任务（无主任务 / 别的会话的任务不算）；
 * 2. 基线：开始观察某个会话时已经存在的对象不算新（切到一个老会话不应弹任务页）。
 *    子代理目录在该会话投影到达前不建基线（否则空基线之后到达的老子代理会被当成新的 —— 它们未必带创建时间）；
 *    后台任务名册里「空」与「未到达」不可区分（宿主把空集存成缺键），所以名册仍用创建时间兜底；
 * 3. 去重：触发过的对象（会话 id + 对象 id）写进 sessionStorage，订阅回调、会话切换、插件重挂、页面刷新都不会再触发。
 *
 * 是否真的打开：
 * - 用户在某会话里手动关闭任务页后，该会话不再自动打开（记在 sessionStorage，刷新后保持）；用户手动打开后重新允许；
 * - 任务页已在该会话的侧栏里（哪怕不是激活标签、哪怕侧栏收起）就什么都不做 —— 宿主的 openTab 对页面标签总会
 *   展开侧栏并 focus 它，revealIfOpened 对页面标签不起作用，只能先查已打开标签。
 */
import { NARROW_MAX_WIDTH } from '../narrow.js'
import { getSidebarPrefs } from '../sidebar-prefs.js'
import { probeJobs, probeSessionList, type JobsService, type SessionListStore } from './host.js'

/** 创建时间的容差：宿主与浏览器时钟差、名册首帧延迟。 */
export const AUTO_OPEN_GRACE_MS = 5000
/** 记住多少个已见对象 / 作用域（有界，丢最旧的）。 */
const MAX_SEEN = 5000
const MAX_SCOPES = 64
/** sessionStorage 里最多记多少个已触发对象 / 已抑制会话。 */
const MAX_FIRED = 500
const MAX_SUPPRESSED = 200
export const AUTO_OPEN_STORAGE_KEY = 'dshws.tasksAutoOpen'

export interface TrackedItem {
  id: string
  createdAt?: number
}

interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

function defaultStorage(): StorageLike | undefined {
  try {
    return typeof sessionStorage === 'undefined' ? undefined : sessionStorage
  } catch {
    return undefined
  }
}

/** 跨订阅回调 / 重挂 / 刷新的记忆：触发过的对象、被用户关闭过任务页的会话。 */
export interface AutoOpenMemory {
  hasFired(key: string): boolean
  markFired(key: string): void
  isSuppressed(sessionId: string): boolean
  suppress(sessionId: string): void
  allow(sessionId: string): void
}

/**
 * 持久到 sessionStorage 的记忆（按浏览器标签页隔离，刷新保留）；存储不可用时退化为仅内存。
 * 每次读写都直接读存储 —— 同一页面里插件重挂后新建的实例也能看到旧实例写下的记录。
 */
export function createAutoOpenMemory(storage: StorageLike | undefined = defaultStorage()): AutoOpenMemory {
  let mem: { fired: string[]; suppressed: string[] } = { fired: [], suppressed: [] }
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const read = (): { fired: string[]; suppressed: string[] } => {
    try {
      const raw = storage?.getItem(AUTO_OPEN_STORAGE_KEY)
      if (raw === null || raw === undefined) return mem
      const o = JSON.parse(raw) as { fired?: unknown; suppressed?: unknown }
      return { fired: strings(o?.fired), suppressed: strings(o?.suppressed) }
    } catch {
      return mem
    }
  }
  const write = (next: { fired: string[]; suppressed: string[] }): void => {
    mem = { fired: next.fired.slice(-MAX_FIRED), suppressed: next.suppressed.slice(-MAX_SUPPRESSED) }
    try {
      storage?.setItem(AUTO_OPEN_STORAGE_KEY, JSON.stringify(mem))
    } catch {
      /* 存储不可用（隐私模式 / 配额）：只靠内存 */
    }
  }
  return {
    hasFired: (key) => read().fired.includes(key),
    markFired(key) {
      const s = read()
      if (!s.fired.includes(key)) write({ ...s, fired: [...s.fired, key] })
    },
    isSuppressed: (sessionId) => read().suppressed.includes(sessionId),
    suppress(sessionId) {
      const s = read()
      if (!s.suppressed.includes(sessionId)) write({ ...s, suppressed: [...s.suppressed, sessionId] })
    },
    allow(sessionId) {
      const s = read()
      if (s.suppressed.includes(sessionId)) write({ ...s, suppressed: s.suppressed.filter((x) => x !== sessionId) })
    }
  }
}

export interface NewObjectTracker {
  /**
   * 观察某作用域（显示中的会话）当前的对象集合，返回本次新出现、且从未触发过的对象 id。
   * @param scope 作用域键（如 'job:<会话>'、'sub:<会话>'），同时是持久去重键的前缀
   * @param now 当前时间（单测注入）
   */
  observe(scope: string, items: readonly TrackedItem[], now?: number): string[]
}

export function createNewObjectTracker(grace = AUTO_OPEN_GRACE_MS, memory: AutoOpenMemory = createAutoOpenMemory(undefined)): NewObjectTracker {
  const scopes = new Map<string, { since: number; seen: Set<string> }>()
  return {
    observe(scope, items, now = Date.now()) {
      let s = scopes.get(scope)
      if (s === undefined) {
        // 首次观察：全部记为基线，不触发。基线只建一次，后续快照只做差。
        if (scopes.size >= MAX_SCOPES) scopes.delete(scopes.keys().next().value as string)
        scopes.set(scope, { since: now, seen: new Set(items.map((i) => i.id)) })
        return []
      }
      const out: string[] = []
      for (const item of items) {
        if (s.seen.has(item.id)) continue
        s.seen.add(item.id)
        if (s.seen.size > MAX_SEEN) s.seen.delete(s.seen.values().next().value as string)
        const key = `${scope}:${item.id}`
        if (memory.hasFired(key)) continue
        if (item.createdAt !== undefined && item.createdAt < s.since - grace) continue
        memory.markFired(key)
        out.push(item.id)
      }
      return out
    }
  }
}

/** 是否应当自动打开（偏好 + 标签开关 + 非窄屏）。 */
export function shouldAutoOpen(prefs: { tasksAutoOpen: boolean; tabs: { tasks: boolean } }, narrow: boolean): boolean {
  return prefs.tasksAutoOpen && prefs.tabs.tasks && !narrow
}

/** 视口是否窄屏（与 narrow.ts 的 useNarrow 同一断点）。 */
export function isNarrowViewport(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(`(max-width: ${NARROW_MAX_WIDTH}px)`).matches
}

export interface AutoOpenDeps {
  get(name: string): unknown
  /** 显示中的会话 id（宿主 uiSession.adapter.current）。 */
  currentSession(): string | undefined
  /** 订阅显示中会话的变化。 */
  subscribeCurrent(listener: () => void): () => void
  /** 在显示中的会话打开任务页（不得抢已打开标签的激活）。 */
  open(): void
  /** 任务页是否已在该会话的侧栏里；宿主查不到返回 undefined。 */
  isTabOpen?(sessionId: string): boolean | undefined
  /** 订阅「用户关闭了某会话的任务页」；宿主不支持返回 undefined。 */
  subscribeClose?(listener: (sessionId: string) => void): (() => void) | undefined
  /** 持久记忆（单测注入）。 */
  memory?: AutoOpenMemory
  log?(message: string, error?: unknown): void
}

/**
 * 安装自动打开。显示中会话变化时重新 watch 它的后台任务名册；会话列表 / 任务名册变化时比对新对象。
 * 宿主缺 ctx.jobs / ctx.sessions 时对应来源静默跳过。
 */
export function installTasksAutoOpen(deps: AutoOpenDeps): () => void {
  const memory = deps.memory ?? createAutoOpenMemory()
  const tracker = createNewObjectTracker(AUTO_OPEN_GRACE_MS, memory)
  /** 本插件自动打开过、还没确认关闭的会话：值 = 打开后是否已在已开标签里看到过它（看到过再消失才算被关闭）。 */
  const autoOpened = new Map<string, boolean>()
  let current: string | undefined
  let releaseRows: (() => void) | undefined
  let jobs: JobsService | undefined
  let list: SessionListStore | undefined
  const offs: Array<() => void> = []

  const tabOpen = (session: string): boolean | undefined => {
    try {
      return deps.isTabOpen?.(session)
    } catch {
      return undefined
    }
  }

  /** 按已打开标签同步「手动关闭 / 手动打开」：关闭事件不可用时，这是检测「曾自动打开、之后被关闭」的兜底。 */
  const syncTabState = (session: string): boolean | undefined => {
    const open = tabOpen(session)
    if (open === true) {
      // 标签在：要么是刚自动打开的，要么是用户手动打开的 —— 两种情况都解除抑制（被抑制时本插件不会自动打开）。
      memory.allow(session)
      if (autoOpened.has(session)) autoOpened.set(session, true)
    } else if (open === false && autoOpened.get(session) === true) {
      memory.suppress(session)
      autoOpened.delete(session)
    }
    return open
  }

  const check = (): void => {
    try {
      const session = current
      if (session === undefined) return
      const open = syncTabState(session)
      const fresh: string[] = []
      if (list !== undefined) {
        // 只认显示中会话目录里的直接子代理；目录未到达前不建基线（见文件头）。
        const catalog = list.getSnapshot().projectionsBySession?.[session]?.values?.subagentCatalog
        if (Array.isArray(catalog)) {
          const items = catalog
            .filter((e) => typeof e?.id === 'string')
            .map((e) => ({ id: e.id, ...(typeof e.createdAt === 'number' ? { createdAt: e.createdAt } : {}) }))
          fresh.push(...tracker.observe(`sub:${session}`, items))
        }
      }
      if (jobs !== undefined) {
        // 名册里还有无主任务（每个会话都看得到）：只算当前会话自己起的。
        const rows = (jobs.state.getSnapshot().rows[session] ?? []).filter((j) => j.owner === session)
        fresh.push(...tracker.observe(`job:${session}`, rows.map((j) => ({ id: j.id, createdAt: j.startedAt }))))
      }
      if (fresh.length === 0 || open === true || memory.isSuppressed(session)) return
      if (!shouldAutoOpen(getSidebarPrefs(), isNarrowViewport())) return
      deps.open()
      autoOpened.set(session, tabOpen(session) === true)
    } catch (error) {
      deps.log?.('任务页自动打开检查失败', error)
    }
  }

  try {
    const off = deps.subscribeClose?.((sessionId) => {
      memory.suppress(sessionId)
      autoOpened.delete(sessionId)
    })
    if (off !== undefined) offs.push(off)
  } catch (error) {
    deps.log?.('订阅任务页关闭失败', error)
  }

  /** 宿主服务可能晚于本插件提供：每次切换会话时补一次探测与订阅。 */
  const ensureSources = (): void => {
    if (list === undefined) {
      list = probeSessionList(deps.get('sessions'))
      if (list !== undefined) offs.push(list.subscribe(check))
    }
    if (jobs === undefined) {
      jobs = probeJobs(deps.get('jobs'))
      if (jobs !== undefined) offs.push(jobs.state.subscribe(check))
    }
  }

  const follow = (): void => {
    const next = deps.currentSession()
    ensureSources()
    if (next === current) return
    releaseRows?.()
    releaseRows = undefined
    current = next
    if (jobs !== undefined && next !== undefined) {
      try {
        releaseRows = jobs.watchRows(next)
      } catch (error) {
        deps.log?.('watch 后台任务名册失败', error)
      }
    }
    check()
  }

  offs.push(deps.subscribeCurrent(follow))
  follow()
  return () => {
    releaseRows?.()
    for (const off of offs) off()
  }
}
