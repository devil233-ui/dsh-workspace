/*
 * @Description: 新子代理 / 新后台任务出现时自动打开任务页（偏好 tasksAutoOpen；窄屏不开；每个新对象只触发一次）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/auto-open.ts
 *
 * 判定「新」的两道关：
 * 1. 基线：开始观察某个会话时已经存在的对象不算新（切到一个老会话不应弹任务页）；
 * 2. 时间：名册 / 目录是异步到达的 —— 第一帧可能是空的，随后才到的老对象会被误判为新，
 *    所以还要求对象的创建时间不早于「开始观察」（留几秒余量容忍时钟差）。没有创建时间的对象只靠基线判断。
 * 只观察显示中的会话（及其任务树），因此「当前会话为显示中会话」天然满足。
 */
import { NARROW_MAX_WIDTH } from '../narrow.js'
import { getSidebarPrefs } from '../sidebar-prefs.js'
import { probeJobs, probeSessionList, type JobsService, type SessionListStore } from './host.js'
import { buildTree, catalogsOf, flattenTree, parentsOf, rootAncestor } from './model.js'

/** 创建时间的容差：宿主与浏览器时钟差、名册首帧延迟。 */
export const AUTO_OPEN_GRACE_MS = 5000
/** 记住多少个已见对象 / 作用域（有界，丢最旧的）。 */
const MAX_SEEN = 5000
const MAX_SCOPES = 64

export interface TrackedItem {
  id: string
  createdAt?: number
}

export interface NewObjectTracker {
  /**
   * 观察某作用域（显示中的会话）当前的对象集合，返回本次新出现、且从未触发过的对象 id。
   * @param scope 作用域键（如 'jobs:<会话>'、'subagents:<会话>'）
   * @param now 当前时间（单测注入）
   */
  observe(scope: string, items: readonly TrackedItem[], now?: number): string[]
}

export function createNewObjectTracker(grace = AUTO_OPEN_GRACE_MS): NewObjectTracker {
  const scopes = new Map<string, { since: number; seen: Set<string> }>()
  const fired = new Set<string>()
  return {
    observe(scope, items, now = Date.now()) {
      let s = scopes.get(scope)
      if (s === undefined) {
        // 首次观察：全部记为基线，不触发。
        if (scopes.size >= MAX_SCOPES) scopes.delete(scopes.keys().next().value as string)
        scopes.set(scope, { since: now, seen: new Set(items.map((i) => i.id)) })
        return []
      }
      const out: string[] = []
      for (const item of items) {
        if (s.seen.has(item.id)) continue
        s.seen.add(item.id)
        if (s.seen.size > MAX_SEEN) s.seen.delete(s.seen.values().next().value as string)
        if (fired.has(item.id)) continue
        if (item.createdAt !== undefined && item.createdAt < s.since - grace) continue
        fired.add(item.id)
        if (fired.size > MAX_SEEN) fired.delete(fired.values().next().value as string)
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
  open(): void
  log?(message: string, error?: unknown): void
}

/**
 * 安装自动打开。显示中会话变化时重新 watch 它的后台任务名册；会话列表 / 任务名册变化时比对新对象。
 * 宿主缺 ctx.jobs / ctx.sessions 时对应来源静默跳过。
 */
export function installTasksAutoOpen(deps: AutoOpenDeps): () => void {
  const tracker = createNewObjectTracker()
  let current: string | undefined
  let releaseRows: (() => void) | undefined
  let jobs: JobsService | undefined
  let list: SessionListStore | undefined
  const offs: Array<() => void> = []

  const check = (): void => {
    try {
      const session = current
      if (session === undefined) return
      const fresh: string[] = []
      if (list !== undefined) {
        const snap = list.getSnapshot()
        const catalogs = catalogsOf(snap)
        const root = rootAncestor(snap, session, parentsOf(snap, catalogs))
        const nodes = flattenTree(buildTree(snap, root, catalogs)).slice(1)
        fresh.push(...tracker.observe(`subagents:${root}`, nodes.map((n) => ({ id: n.id, ...(n.createdAt === undefined ? {} : { createdAt: n.createdAt }) }))))
      }
      if (jobs !== undefined) {
        const rows = jobs.state.getSnapshot().rows[session] ?? []
        fresh.push(...tracker.observe(`jobs:${session}`, rows.map((j) => ({ id: `job:${j.id}`, createdAt: j.startedAt }))))
      }
      if (fresh.length > 0 && shouldAutoOpen(getSidebarPrefs(), isNarrowViewport())) deps.open()
    } catch (error) {
      deps.log?.('任务页自动打开检查失败', error)
    }
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
