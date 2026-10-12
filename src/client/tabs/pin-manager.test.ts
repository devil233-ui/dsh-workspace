/*
 * @Description: 固定标签运行时测试 —— 用假的右侧栏控制器（adopted store + placeTab + openResourceIn）验证补开、重排、关闭即取消固定、会话切换与降级
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/pin-manager.test.ts
 */
import { describe, expect, it } from 'vitest'
import type { LayoutLike, SidebarRightLike, TabRecordLike } from './host-layout.js'
import { createPinManager } from './pin-manager.js'
import { PINS_KEY_PREFIX, type StorageLike } from './pins.js'

const FILE = 'dsh-workspace:remote-file'
const file = (id: string): TabRecordLike => ({ id, kind: FILE, contentId: `dsh-resource://file/absolute/${id}` })

/** 最小的宿主替身：单会话仓库，动作同步提交并通知订阅者（与宿主一致）。 */
function fakeHost(sessionId: string, initial: LayoutLike | undefined) {
  let layout = initial
  const subs = new Set<() => void>()
  const commit = (next: LayoutLike): void => {
    layout = next
    for (const s of [...subs]) s()
  }
  const pane = (id: string) => layout!.nodes[id] as { tabs: string[]; activeTabId?: string }
  const store = {
    getSnapshot: () => ({ bySession: layout === undefined ? {} : { [sessionId]: { layout } } }),
    subscribe: (l: () => void) => {
      subs.add(l)
      return () => subs.delete(l)
    },
    actions: {
      placeTab: (_sid: string, tabId: string, paneId: string, index: number) => {
        const tabs = [...pane(paneId).tabs]
        const from = tabs.indexOf(tabId)
        const to = index > from ? index - 1 : index
        tabs.splice(from, 1)
        tabs.splice(to, 0, tabId)
        commit({ ...layout!, nodes: { ...layout!.nodes, [paneId]: { ...(layout!.nodes[paneId] as object), tabs } as never } })
      },
      focusTab: (_sid: string, tabId: string) => {
        focused.push(tabId)
      }
    }
  }
  const focused: string[] = []
  const opened: Array<{ address: string; options: Record<string, unknown> }> = []
  let mounted: string | undefined = sessionId
  const mountedSubs = new Set<() => void>()
  let adopted = true
  const right: SidebarRightLike = {
    adopted: { get: (sid) => (adopted && sid === sessionId ? { store: store as never } : undefined) },
    mounted: {
      getSnapshot: () => mounted,
      subscribe: (l) => {
        mountedSubs.add(l)
        return () => mountedSubs.delete(l)
      }
    },
    openResourceIn: (_sid, address, options = {}) => {
      opened.push({ address, options })
      const id = `new-${opened.length}`
      const paneId = options.paneId as string
      const replace = options.replaceTab as string | undefined
      const tabs = pane(paneId).tabs.filter((t) => t !== replace)
      const nextTabs = { ...layout!.tabs, [id]: { id, kind: options.kind as string, contentId: address } }
      if (replace !== undefined) delete nextTabs[replace]
      commit({ ...layout!, tabs: nextTabs, nodes: { ...layout!.nodes, [paneId]: { ...(layout!.nodes[paneId] as object), tabs: [...tabs, id], activeTabId: id } as never } })
    },
    openTabIn: () => undefined,
    closeIn: (_sid, tabId) => {
      const nodes = { ...layout!.nodes }
      for (const [k, n] of Object.entries(nodes)) if (n?.kind === 'pane' && n.tabs.includes(tabId)) nodes[k] = { ...n, tabs: n.tabs.filter((t) => t !== tabId) }
      const tabs = { ...layout!.tabs }
      delete tabs[tabId]
      commit({ ...layout!, nodes, tabs })
    }
  }
  return {
    right,
    opened,
    focused,
    get layout() {
      return layout!
    },
    commit,
    setMounted(sid: string | undefined) {
      mounted = sid
      for (const s of [...mountedSubs]) s()
    },
    setAdopted(v: boolean) {
      adopted = v
    }
  }
}

function single(tabIds: string[], expanded = true, extra: TabRecordLike[] = []): LayoutLike {
  const tabs: LayoutLike['tabs'] = {}
  for (const id of tabIds) tabs[id] = id.startsWith('g') ? { id, kind: 'guide', contentId: 'sidebar://guide' } : file(id)
  for (const t of extra) tabs[t.id] = t
  return { rootId: 'A', nodes: { A: { kind: 'pane', id: 'A', host: 'dock', tabs: tabIds, activeTabId: tabIds[tabIds.length - 1] } }, floats: [], expanded, tabs, activePaneId: 'A' }
}

function memStorage(): StorageLike & { map: Map<string, string> } {
  const map = new Map<string, string>()
  return { map, getItem: (k) => map.get(k) ?? null, setItem: (k, v) => void map.set(k, v), removeItem: (k) => void map.delete(k) }
}

/** 同步执行「微任务」，便于断言；delay 收集起来手动触发。 */
function harness(host: ReturnType<typeof fakeHost>, storage = memStorage()) {
  const timers: Array<() => void> = []
  const queue: Array<() => void> = []
  const logs: string[] = []
  const manager = createPinManager({
    right: () => host.right,
    isMultiple: () => undefined,
    storage: () => storage,
    log: (m) => logs.push(m),
    schedule: (fn) => queue.push(fn),
    delay: (fn) => {
      timers.push(fn)
      return () => undefined
    },
    doc: () => undefined
  })
  const drain = (): void => {
    for (let i = 0; i < 20 && queue.length > 0; i++) queue.shift()!()
  }
  return { manager, storage, timers, drain, logs }
}

describe('固定标签运行时', () => {
  it('固定后排到窗格最左；顺序已正确时不再派发', () => {
    const host = fakeHost('s1', single(['a', 'b', 'c']))
    const h = harness(host)
    expect(h.manager.pin('s1', file('c'))).toBe(true)
    h.drain()
    expect((host.layout.nodes.A as { tabs: string[] }).tabs).toEqual(['c', 'a', 'b'])
    h.manager.pin('s1', file('b'))
    h.drain()
    expect((host.layout.nodes.A as { tabs: string[] }).tabs).toEqual(['c', 'b', 'a'])
    expect([...h.manager.pinnedIds('s1')]).toEqual(['c', 'b'])
    expect(JSON.parse(h.storage.map.get(`${PINS_KEY_PREFIX}s1`)!)).toHaveLength(2)
  })

  it('关闭固定标签 = 取消固定（含宿主内置「关闭」走的同一条布局变化）', () => {
    const host = fakeHost('s1', single(['a', 'b']))
    const h = harness(host)
    h.manager.pin('s1', file('b'))
    h.drain()
    host.right.closeIn!('s1', 'b')
    expect(h.manager.isPinned('s1', file('b'))).toBe(false)
  })

  it('展开 false → true 时补开缺失的固定项（顶替引导页），并恢复原激活标签', () => {
    const storage = memStorage()
    storage.setItem(`${PINS_KEY_PREFIX}s1`, JSON.stringify([{ kind: FILE, contentId: 'dsh-resource://file/absolute/x', paneIndex: 0 }]))
    const host = fakeHost('s1', single(['g1'], false))
    const h = harness(host, storage)
    h.drain()
    expect(host.opened).toHaveLength(0)
    host.commit({ ...host.layout, expanded: true })
    h.drain()
    expect(host.opened).toEqual([{ address: 'dsh-resource://file/absolute/x', options: { paneId: 'A', replaceTab: 'g1', kind: FILE } }])
    expect(Object.values(host.layout.tabs).map((t) => t!.contentId)).toEqual(['dsh-resource://file/absolute/x'])
    // 再次变化（已存在）不重复补开，固定也没有被当成「关闭」移除。
    host.commit({ ...host.layout })
    h.drain()
    expect(host.opened).toHaveLength(1)
    expect(h.manager.pins('s1')).toHaveLength(1)
  })

  it('挂上时已展开：补开；用户刚打开的标签仍保持激活', () => {
    const storage = memStorage()
    storage.setItem(`${PINS_KEY_PREFIX}s1`, JSON.stringify([{ kind: FILE, contentId: 'dsh-resource://file/absolute/x' }]))
    const host = fakeHost('s1', single(['a', 'b']))
    const h = harness(host, storage)
    h.drain()
    expect(host.opened).toHaveLength(1)
    expect(host.focused).toEqual(['b'])
    expect((host.layout.nodes.A as { tabs: string[] }).tabs[0]).toBe('new-1')
  })

  it('会话布局尚未 adopt：短轮询等到再挂；期间不误删固定', () => {
    const storage = memStorage()
    storage.setItem(`${PINS_KEY_PREFIX}s1`, JSON.stringify([{ kind: FILE, contentId: 'dsh-resource://file/absolute/a' }]))
    const host = fakeHost('s1', single(['a']))
    host.setAdopted(false)
    const h = harness(host, storage)
    expect(h.timers).toHaveLength(1)
    host.setAdopted(true)
    h.timers.shift()!()
    h.drain()
    expect([...h.manager.pinnedIds('s1')]).toEqual(['a'])
    expect(h.manager.pins('s1')).toHaveLength(1)
  })

  it('切换会话后旧会话的布局变化不再触发取消固定；固定按会话独立', () => {
    const host = fakeHost('s1', single(['a', 'b']))
    const h = harness(host)
    h.manager.pin('s1', file('a'))
    h.drain()
    host.setMounted('s2')
    host.right.closeIn!('s1', 'a')
    expect(h.manager.isPinned('s1', file('a'))).toBe(true)
    expect(h.manager.pins('s2')).toEqual([])
  })

  it('降级：读不到布局时固定失败返回 false、pinnedIds 为空，不抛错', () => {
    const host = fakeHost('s1', undefined)
    const h = harness(host)
    expect(h.manager.pin('s1', file('a'))).toBe(false)
    expect(h.manager.pinnedIds('s1').size).toBe(0)
    h.manager.dispose()
  })
})
