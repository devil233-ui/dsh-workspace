/*
 * @Description: 任务页自动打开（新对象去重、基线、偏好 / 窄屏判断、安装后的端到端行为）的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/auto-open.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createNewObjectTracker, installTasksAutoOpen, shouldAutoOpen } from './auto-open.js'
import { setSidebarPrefs } from '../sidebar-prefs.js'
import { DEFAULT_SIDEBAR_PREFS, mergeSidebarPrefs } from '../../wire/sidebar-prefs.js'
import type { JobView, JobsSnapshot, SessionListSnapshot } from './host.js'

describe('createNewObjectTracker', () => {
  it('首次观察是基线；之后只返回新对象，每个对象只触发一次', () => {
    const tr = createNewObjectTracker()
    expect(tr.observe('s', [{ id: 'a' }], 1000)).toEqual([])
    expect(tr.observe('s', [{ id: 'a' }, { id: 'b' }], 2000)).toEqual(['b'])
    expect(tr.observe('s', [{ id: 'a' }, { id: 'b' }], 3000)).toEqual([])
    // 同一对象在别的作用域里再出现也不再触发
    tr.observe('t', [], 3000)
    expect(tr.observe('t', [{ id: 'b' }, { id: 'c' }], 4000)).toEqual(['c'])
  })

  it('异步到达的老对象（创建时间早于开始观察）不算新', () => {
    const tr = createNewObjectTracker(5000)
    expect(tr.observe('s', [], 100_000)).toEqual([])
    expect(tr.observe('s', [{ id: 'old', createdAt: 10_000 }, { id: 'edge', createdAt: 96_000 }, { id: 'new', createdAt: 100_500 }], 101_000)).toEqual(['edge', 'new'])
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

  function setup() {
    let list: SessionListSnapshot = { byId: { root: { id: 'root' } }, projectionsBySession: { root: { values: { subagentCatalog: [] } } } }
    let jobs: JobsSnapshot = { rows: {}, observed: {} }
    const listListeners = new Set<() => void>()
    const jobListeners = new Set<() => void>()
    const currentListeners = new Set<() => void>()
    const watched: string[] = []
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
      }
    })
    return {
      off,
      watched,
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
      }
    }
  }

  const job = (id: string, startedAt = Date.now()): JobView => ({ id, kind: 'bash', label: 'x', status: 'running', startedAt })

  it('新子代理 / 新后台任务各触发一次；老对象与重复不触发；watch 显示中会话的名册', () => {
    const s = setup()
    expect(s.watched).toEqual(['root'])
    s.setList({ byId: { root: { id: 'root' } }, projectionsBySession: { root: { values: { subagentCatalog: [{ id: 'c1', createdAt: Date.now(), mode: 'one-shot' }] } } } })
    expect(s.opened()).toBe(1)
    s.setList({ byId: { root: { id: 'root' } }, projectionsBySession: { root: { values: { subagentCatalog: [{ id: 'c1', createdAt: Date.now(), mode: 'one-shot' }] } } } })
    expect(s.opened()).toBe(1)
    // 名册首帧带来的老任务（开始时间早于观察）不触发
    s.setJobs('root', [job('bash-1', Date.now() - 3_600_000)])
    expect(s.opened()).toBe(1)
    s.setJobs('root', [job('bash-1', Date.now() - 3_600_000), job('bash-2')])
    expect(s.opened()).toBe(2)
    s.off()
    expect(s.watched).toEqual([])
  })

  it('偏好关闭或窄屏时不打开（仍记为已见，之后打开偏好也不补触发）', () => {
    setSidebarPrefs(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { tasksAutoOpen: false }))
    const s = setup()
    s.setJobs('root', [job('j1')])
    expect(s.opened()).toBe(0)
    setSidebarPrefs(DEFAULT_SIDEBAR_PREFS)
    s.setJobs('root', [job('j1')])
    expect(s.opened()).toBe(0)
    s.off()
  })

  it('切换显示中会话：改 watch 新会话，新会话已有的对象作为基线', () => {
    const s = setup()
    s.switchTo('other')
    expect(s.watched).toEqual(['other'])
    s.setJobs('other', [job('j9')])
    // 'other' 的首帧到达前，基线已在切换时以空集建立；j9 开始时间晚于观察，算新
    expect(s.opened()).toBe(1)
    s.off()
  })

  it('宿主没有 jobs / sessions 服务：静默跳过', () => {
    const off = installTasksAutoOpen({ get: () => undefined, currentSession: () => 's', subscribeCurrent: () => () => undefined, open: () => undefined })
    off()
  })
})
