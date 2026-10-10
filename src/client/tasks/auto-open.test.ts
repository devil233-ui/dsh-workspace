/*
 * @Description: 任务页自动打开（新对象去重、基线、持久记忆、手动关闭抑制、不抢焦点、偏好 / 窄屏判断、安装后的端到端行为）的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/auto-open.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest'
import { AUTO_OPEN_STORAGE_KEY, createAutoOpenMemory, createNewObjectTracker, installTasksAutoOpen, shouldAutoOpen, type AutoOpenMemory } from './auto-open.js'
import { setSidebarPrefs } from '../sidebar-prefs.js'
import { DEFAULT_SIDEBAR_PREFS, mergeSidebarPrefs } from '../../wire/sidebar-prefs.js'
import type { CatalogEntry, JobView, JobsSnapshot, SessionListSnapshot } from './host.js'

function memoryStorage() {
  const data = new Map<string, string>()
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

describe('createNewObjectTracker', () => {
  it('首次观察是基线；之后只返回新对象，每个对象只触发一次', () => {
    const tr = createNewObjectTracker()
    expect(tr.observe('s', [{ id: 'a' }], 1000)).toEqual([])
    expect(tr.observe('s', [{ id: 'a' }, { id: 'b' }], 2000)).toEqual(['b'])
    expect(tr.observe('s', [{ id: 'a' }, { id: 'b' }], 3000)).toEqual([])
  })

  it('异步到达的老对象（创建时间早于开始观察）不算新', () => {
    const tr = createNewObjectTracker(5000)
    expect(tr.observe('s', [], 100_000)).toEqual([])
    expect(tr.observe('s', [{ id: 'old', createdAt: 10_000 }, { id: 'edge', createdAt: 96_000 }, { id: 'new', createdAt: 100_500 }], 101_000)).toEqual(['edge', 'new'])
  })

  it('去重持久到存储：重建 tracker（插件重挂 / 刷新）后空基线之后再到达的同一对象不再触发', () => {
    const storage = memoryStorage()
    const a = createNewObjectTracker(5000, createAutoOpenMemory(storage))
    a.observe('job:s', [], 1000)
    expect(a.observe('job:s', [{ id: 'j1', createdAt: 1000 }], 1500)).toEqual(['j1'])
    expect(JSON.parse(storage.data.get(AUTO_OPEN_STORAGE_KEY)!).fired).toEqual(['job:s:j1'])
    const b = createNewObjectTracker(5000, createAutoOpenMemory(storage))
    b.observe('job:s', [], 1600)
    expect(b.observe('job:s', [{ id: 'j1', createdAt: 1000 }], 1700)).toEqual([])
  })

  it('去重键含会话：不同会话里同名的任务 id 各算各的', () => {
    const tr = createNewObjectTracker()
    tr.observe('job:a', [], 0)
    tr.observe('job:b', [], 0)
    expect(tr.observe('job:a', [{ id: 'bash-1' }], 1)).toEqual(['bash-1'])
    expect(tr.observe('job:b', [{ id: 'bash-1' }], 1)).toEqual(['bash-1'])
  })
})

describe('createAutoOpenMemory', () => {
  it('抑制 / 解除抑制持久，存储坏数据或不可用时不抛', () => {
    const storage = memoryStorage()
    const m = createAutoOpenMemory(storage)
    m.suppress('s1')
    expect(createAutoOpenMemory(storage).isSuppressed('s1')).toBe(true)
    m.allow('s1')
    expect(createAutoOpenMemory(storage).isSuppressed('s1')).toBe(false)
    storage.data.set(AUTO_OPEN_STORAGE_KEY, '{bad')
    expect(createAutoOpenMemory(storage).hasFired('x')).toBe(false)
    const broken = createAutoOpenMemory({ getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    broken.markFired('k')
    expect(broken.hasFired('k')).toBe(true)
  })
})

describe('shouldAutoOpen', () => {
  it('偏好开 + 标签开 + 非窄屏', () => {
    const p = { tasksAutoOpen: true, tabs: { tasks: true } }
    expect(shouldAutoOpen(p, false)).toBe(true)
    expect(shouldAutoOpen(p, true)).toBe(false)
    expect(shouldAutoOpen({ ...p, tasksAutoOpen: false }, false)).toBe(false)
    expect(shouldAutoOpen({ tasksAutoOpen: true, tabs: { tasks: false } }, false)).toBe(false)
  })
})

describe('installTasksAutoOpen', () => {
  afterEach(() => setSidebarPrefs(DEFAULT_SIDEBAR_PREFS))

  const catalogOf = (byParent: Record<string, CatalogEntry[]>): SessionListSnapshot => ({
    byId: { root: { id: 'root' } },
    projectionsBySession: Object.fromEntries(Object.entries(byParent).map(([id, entries]) => [id, { values: { subagentCatalog: entries } }]))
  })

  function setup(opts: { memory?: AutoOpenMemory; tabsIn?: boolean; closeEvents?: boolean } = {}) {
    let list: SessionListSnapshot = catalogOf({ root: [] })
    let jobs: JobsSnapshot = { rows: {}, observed: {} }
    const listListeners = new Set<() => void>()
    const jobListeners = new Set<() => void>()
    const currentListeners = new Set<() => void>()
    const closeListeners = new Set<(id: string) => void>()
    const watched: string[] = []
    /** 模拟宿主侧栏：各会话是否已打开任务页。 */
    const openTabs = new Set<string>()
    let current = 'root'
    let opened = 0
    const services: Record<string, unknown> = {
      sessions: { list: { getSnapshot: () => list, subscribe: (l: () => void) => (listListeners.add(l), () => listListeners.delete(l)) } },
      jobs: {
        state: { getSnapshot: () => jobs, subscribe: (l: () => void) => (jobListeners.add(l), () => jobListeners.delete(l)) },
        watchRows: (id: string) => (watched.push(id), () => watched.splice(watched.indexOf(id), 1)),
        observe: () => () => undefined,
        kill: async () => undefined
      }
    }
    const off = installTasksAutoOpen({
      get: (n) => services[n],
      currentSession: () => current,
      subscribeCurrent: (l) => (currentListeners.add(l), () => currentListeners.delete(l)),
      open: () => {
        opened += 1
        openTabs.add(current)
      },
      ...(opts.tabsIn === false ? {} : { isTabOpen: (id: string) => openTabs.has(id) }),
      ...(opts.closeEvents === false ? {} : { subscribeClose: (l: (id: string) => void) => (closeListeners.add(l), () => closeListeners.delete(l)) }),
      memory: opts.memory ?? createAutoOpenMemory(memoryStorage())
    })
    return {
      off,
      watched,
      openTabs,
      opened: () => opened,
      setList(next: SessionListSnapshot) {
        list = next
        for (const l of listListeners) l()
      },
      setJobs(sessionId: string, rows: JobView[]) {
        jobs = { rows: { ...jobs.rows, [sessionId]: rows }, observed: {} }
        for (const l of jobListeners) l()
      },
      switchTo(id: string) {
        current = id
        for (const l of currentListeners) l()
      },
      /** 用户点标签的关闭按钮（宿主先调 close handler，再移除标签）。 */
      userClose(id: string, notify = true) {
        if (notify) for (const l of closeListeners) l(id)
        openTabs.delete(id)
      },
      /** 用户手动打开任务页（不经本插件）。 */
      userOpen(id: string) {
        openTabs.add(id)
      }
    }
  }

  const job = (id: string, owner = 'root', startedAt = Date.now()): JobView => ({ id, kind: 'bash', label: 'x', owner, status: 'running', startedAt })
  const sub = (id: string, createdAt?: number): CatalogEntry => ({ id, mode: 'one-shot', ...(createdAt === undefined ? {} : { createdAt }) })

  it('新子代理 / 新后台任务触发打开；重复快照与状态变化不重复触发；watch 显示中会话的名册', () => {
    const s = setup()
    expect(s.watched).toEqual(['root'])
    s.setList(catalogOf({ root: [sub('c1', Date.now())] }))
    expect(s.opened()).toBe(1)
    s.userClose('root', false)
    // 同一快照反复推送（含 job 状态变化）不触发
    s.setList(catalogOf({ root: [sub('c1', Date.now())] }))
    s.setJobs('root', [job('bash-1', 'root', Date.now() - 3_600_000)])
    s.setJobs('root', [{ ...job('bash-1', 'root', Date.now() - 3_600_000), status: 'completed' }])
    expect(s.opened()).toBe(1)
    s.off()
    expect(s.watched).toEqual([])
  })

  it('已打开（哪怕不是激活标签）不再调用 openTab，不抢焦点', () => {
    const s = setup()
    s.userOpen('root')
    s.setJobs('root', [job('j1')])
    s.setList(catalogOf({ root: [sub('c1', Date.now())] }))
    expect(s.opened()).toBe(0)
    s.off()
  })

  it('手动关闭（关闭事件）后本会话不再自动打开；手动重新打开后恢复', () => {
    const s = setup()
    s.setJobs('root', [job('j1')])
    expect(s.opened()).toBe(1)
    s.userClose('root')
    s.setJobs('root', [job('j1'), job('j2')])
    s.setList(catalogOf({ root: [sub('c1', Date.now())] }))
    expect(s.opened()).toBe(1)
    // 用户手动打开 → 下次检查解除抑制（已打开所以不调用 openTab）
    s.userOpen('root')
    s.setJobs('root', [job('j1'), job('j2'), job('j3')])
    expect(s.opened()).toBe(1)
    // 标签不经关闭事件消失（不是本插件打开的，兜底不判为手动关闭）→ 已解除抑制，新对象再次触发
    s.userClose('root', false)
    s.setJobs('root', [job('j1'), job('j2'), job('j3'), job('j4')])
    expect(s.opened()).toBe(2)
    s.off()
  })

  it('没有关闭事件时靠已打开标签兜底：曾自动打开、之后消失即视为手动关闭', () => {
    const s = setup({ closeEvents: false })
    s.setJobs('root', [job('j1')])
    expect(s.opened()).toBe(1)
    // 打开后至少一次检查看到它在（订阅回调里状态推送）
    s.setJobs('root', [{ ...job('j1'), progress: '50%' }])
    s.userClose('root', false)
    s.setJobs('root', [job('j1'), job('j2')])
    expect(s.opened()).toBe(1)
    s.off()
  })

  it('手动关闭的抑制持久到存储：重装（刷新）后仍不打开', () => {
    const storage = memoryStorage()
    const a = setup({ memory: createAutoOpenMemory(storage) })
    a.setJobs('root', [job('j1')])
    a.userClose('root')
    a.off()
    const b = setup({ memory: createAutoOpenMemory(storage) })
    b.setJobs('root', [job('j2')])
    expect(b.opened()).toBe(0)
    b.off()
  })

  it('只算当前会话自己产生的：无主任务、别的会话的任务、孙代理不触发', () => {
    const s = setup()
    s.setJobs('root', [{ ...job('free'), owner: undefined } as JobView, job('other', 'x')])
    s.setList(catalogOf({ root: [], c1: [sub('g1', Date.now())] }))
    expect(s.opened()).toBe(0)
    s.off()
  })

  it('子代理目录未到达前不建基线：之后到达的老子代理（无创建时间）不触发', () => {
    const s = setup()
    s.switchTo('other')
    s.setList(catalogOf({ root: [] }))
    s.setList(catalogOf({ root: [], other: [sub('old1'), sub('old2')] }))
    expect(s.opened()).toBe(0)
    s.setList(catalogOf({ root: [], other: [sub('old1'), sub('old2'), sub('new1')] }))
    expect(s.opened()).toBe(1)
    s.off()
  })

  it('切换会话：改 watch 新会话；切回原会话不重复触发；抑制按会话隔离', () => {
    const s = setup()
    s.setJobs('root', [job('j1')])
    expect(s.opened()).toBe(1)
    s.userClose('root')
    s.switchTo('other')
    expect(s.watched).toEqual(['other'])
    s.setJobs('other', [job('k1', 'other')])
    expect(s.opened()).toBe(2)
    s.switchTo('root')
    s.setJobs('root', [job('j1')])
    expect(s.opened()).toBe(2)
    s.off()
  })

  it('偏好关闭时不打开（仍记为已见，之后打开偏好也不补触发）', () => {
    setSidebarPrefs(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { tasksAutoOpen: false }))
    const s = setup()
    s.setJobs('root', [job('j1')])
    expect(s.opened()).toBe(0)
    setSidebarPrefs(DEFAULT_SIDEBAR_PREFS)
    s.setJobs('root', [job('j1')])
    expect(s.opened()).toBe(0)
    s.off()
  })

  it('宿主没有 jobs / sessions / 侧栏能力：静默跳过', () => {
    const off = installTasksAutoOpen({ get: () => undefined, currentSession: () => 's', subscribeCurrent: () => () => undefined, open: () => undefined })
    off()
  })
})
