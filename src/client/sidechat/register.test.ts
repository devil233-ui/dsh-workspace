/*
 * @Description: 侧边对话注册与动作的测试 —— 资源提供方的引用 / 释放 / 失败帧、分叉流程、按偏好注册撤销、线程父会话解析
 * @Author: YangHeng
 * @Date: 2026-10-10 20:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/register.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSidebarPrefs, setSidebarPrefs } from '../sidebar-prefs.js'
import { DEFAULT_SIDEBAR_PREFS, mergeSidebarPrefs } from '../../wire/sidebar-prefs.js'
import { createSidechatActions, registerSidechat, sidechatResourceProvider } from './register.js'
import { confirmAndDelete, existsIn, threadParentOf } from './SidechatTab.js'
import { sidechatAddress } from './address.js'
import { createSidechatHost, isSessionActiveRefusal, type SidechatHost } from './host.js'
import type { WorkspaceApi } from '../api.js'

afterEach(() => setSidebarPrefs(DEFAULT_SIDEBAR_PREFS))

describe('sidechatResourceProvider', () => {
  it('打开期间持有引用，abort 后释放', async () => {
    const release = vi.fn()
    const retain = vi.fn(() => ({ sessionId: 'c', release }))
    const provider = sidechatResourceProvider(() => ({ fork: vi.fn(), retain }))
    const ac = new AbortController()
    const it = provider.open(sidechatAddress('c', 'p'), { signal: ac.signal })
    const first = await it.next()
    expect(first.value).toMatchObject({ ok: true, value: { address: { childId: 'c', parentId: 'p' } } })
    expect(retain).toHaveBeenCalledWith('c', expect.objectContaining({ source: 'dshws-sidechat' }))
    const done = it.next()
    expect(release).not.toHaveBeenCalled()
    ac.abort()
    await done
    expect(release).toHaveBeenCalledTimes(1)
  })

  it('会话不存在 / 地址非法 / 无 sessions 服务 → 失败帧', async () => {
    const ac = new AbortController()
    const unknown = sidechatResourceProvider(() => ({ fork: vi.fn(), retain: () => { throw new Error('unknown session') } }))
    expect((await unknown.open(sidechatAddress('x'), { signal: ac.signal }).next()).value).toMatchObject({ ok: false })
    expect((await unknown.open('dsh-resource://dshws-sidechat/bad', { signal: ac.signal }).next()).value).toMatchObject({ ok: false })
    const none = sidechatResourceProvider(() => undefined)
    expect((await none.open(sidechatAddress('x'), { signal: ac.signal }).next()).value).toMatchObject({ ok: false })
  })
})

function fakeHost(over: Partial<SidechatHost> = {}): SidechatHost {
  return {
    available: () => true,
    sessionList: () => undefined,
    fork: vi.fn(async () => 'child'),
    openAside: vi.fn(() => true),
    openMain: vi.fn(() => true),
    archive: vi.fn(async () => undefined),
    closeTabsOf: vi.fn(() => 1),
    ...over
  }
}

function fakeApi(): WorkspaceApi & { calls: unknown[] } {
  const calls: unknown[] = []
  return {
    calls,
    call: (async (method: string, payload: unknown) => {
      calls.push([method, payload])
      return { sidebar: mergeSidebarPrefs(getSidebarPrefs(), payload as never) }
    }) as never
  }
}

describe('createSidechatActions', () => {
  it('分叉 → 记录来源 → 侧栏打开；侧栏打不开退回主区', async () => {
    const host = fakeHost()
    const api = fakeApi()
    await createSidechatActions(host, api, () => undefined, () => 42).start('parent')
    expect(host.fork).toHaveBeenCalledWith('parent')
    expect(getSidebarPrefs().sidechats).toEqual([{ parentId: 'parent', childId: 'child', createdAt: 42 }])
    expect(host.openAside).toHaveBeenCalledWith('child', 'parent')
    expect(host.openMain).not.toHaveBeenCalled()
    const host2 = fakeHost({ openAside: vi.fn(() => false), fork: vi.fn(async () => 'child2') })
    await createSidechatActions(host2, api, () => undefined, () => 43).start('parent')
    expect(host2.openMain).toHaveBeenCalledWith('child2')
    await createSidechatActions(host2, api, () => undefined).remove('child')
    expect(getSidebarPrefs().sidechats.map((r) => r.childId)).toEqual(['child2'])
  })

  it('分叉失败抛给调用方，不写记录', async () => {
    const host = fakeHost({ fork: vi.fn(async () => { throw new Error('blank') }) })
    await expect(createSidechatActions(host, fakeApi(), () => undefined).start('p')).rejects.toThrow('blank')
    expect(getSidebarPrefs().sidechats).toEqual([])
  })

  it('删除成功：归档左侧会话 → 关闭已打开的标签 → 移除记录', async () => {
    setSidebarPrefs(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { sidechats: [{ parentId: 'p', childId: 'c1', createdAt: 1 }, { parentId: 'p', childId: 'c2', createdAt: 2 }] }))
    const order: string[] = []
    const host = fakeHost({
      archive: vi.fn(async () => void order.push('archive')),
      closeTabsOf: vi.fn(() => (order.push('close'), 1))
    })
    await createSidechatActions(host, fakeApi(), () => undefined).delete('c1', { stopActivity: true })
    expect(host.archive).toHaveBeenCalledWith('c1', { stopActivity: true })
    expect(host.closeTabsOf).toHaveBeenCalledWith('c1')
    expect(order).toEqual(['archive', 'close'])
    expect(getSidebarPrefs().sidechats.map((r) => r.childId)).toEqual(['c2'])
  })

  it('删除失败：错误抛给调用方，不关标签、不删记录', async () => {
    setSidebarPrefs(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { sidechats: [{ parentId: 'p', childId: 'c1', createdAt: 1 }] }))
    const host = fakeHost({ archive: vi.fn(async () => { throw new Error('refused') }) })
    await expect(createSidechatActions(host, fakeApi(), () => undefined).delete('c1')).rejects.toThrow('refused')
    expect(host.closeTabsOf).not.toHaveBeenCalled()
    expect(getSidebarPrefs().sidechats.map((r) => r.childId)).toEqual(['c1'])
  })

  it('关标签抛错只记日志，记录照常移除', async () => {
    setSidebarPrefs(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { sidechats: [{ parentId: 'p', childId: 'c1', createdAt: 1 }] }))
    const logs: string[] = []
    const host = fakeHost({ closeTabsOf: vi.fn(() => { throw new Error('x') }) })
    await createSidechatActions(host, fakeApi(), (m) => logs.push(m)).delete('c1')
    expect(logs).toHaveLength(1)
    expect(getSidebarPrefs().sidechats).toEqual([])
  })
})

describe('confirmAndDelete', () => {
  const activeRefusal = (): Error => Object.assign(new Error('busy'), { name: 'WorkspaceArchiveError', rpcError: { code: 'workspace/session-active' } })

  it('取消确认：不调用删除', async () => {
    const del = vi.fn(async () => undefined)
    await expect(confirmAndDelete('c', { confirm: async () => false, del })).resolves.toBe('cancelled')
    expect(del).not.toHaveBeenCalled()
  })

  it('确认后删除成功', async () => {
    const del = vi.fn(async () => undefined)
    await expect(confirmAndDelete('c', { confirm: async () => true, del })).resolves.toBe('deleted')
    expect(del).toHaveBeenCalledWith('c')
  })

  it('会话仍在运行：再确认后带 stopActivity 重试；再次取消则不重试', async () => {
    const steps: string[] = []
    const del = vi.fn(async (_id: string, options?: { stopActivity?: boolean }) => {
      if (options?.stopActivity !== true) throw activeRefusal()
    })
    await expect(confirmAndDelete('c', { confirm: async (s) => (steps.push(s), true), del })).resolves.toBe('deleted')
    expect(steps).toEqual(['delete', 'stop'])
    expect(del).toHaveBeenLastCalledWith('c', { stopActivity: true })
    const del2 = vi.fn(async () => { throw activeRefusal() })
    await expect(confirmAndDelete('c', { confirm: async (s) => s === 'delete', del: del2 })).resolves.toBe('cancelled')
    expect(del2).toHaveBeenCalledTimes(1)
  })

  it('其他失败原样抛出', async () => {
    await expect(confirmAndDelete('c', { confirm: async () => true, del: async () => { throw new Error('boom') } })).rejects.toThrow('boom')
  })
})

describe('isSessionActiveRefusal', () => {
  it('只认宿主 workspace/session-active 拒绝', () => {
    expect(isSessionActiveRefusal(Object.assign(new Error('x'), { name: 'WorkspaceArchiveError', rpcError: { code: 'workspace/session-active' } }))).toBe(true)
    expect(isSessionActiveRefusal(Object.assign(new Error('x'), { name: 'WorkspaceArchiveError', rpcError: { code: 'session/not-found' } }))).toBe(false)
    expect(isSessionActiveRefusal(new Error('x'))).toBe(false)
    expect(isSessionActiveRefusal('x')).toBe(false)
  })
})

describe('createSidechatHost: archive / closeTabsOf', () => {
  it('优先 uiWorkspace.archiveSession，退回 workspaces；都没有抛错', async () => {
    const ui = { archiveSession: vi.fn(async () => undefined) }
    const ws = { archiveSession: vi.fn(async () => undefined) }
    await createSidechatHost({ get: (n) => ({ uiWorkspace: ui, workspaces: ws })[n as 'uiWorkspace'] }, () => undefined).archive('s', { stopActivity: true })
    expect(ui.archiveSession).toHaveBeenCalledWith('s', { stopActivity: true })
    await createSidechatHost({ get: (n) => (n === 'workspaces' ? ws : undefined) }, () => undefined).archive('s')
    expect(ws.archiveSession).toHaveBeenCalledWith('s', {})
    await expect(createSidechatHost({ get: () => undefined }, () => undefined).archive('s')).rejects.toThrow()
  })

  it('关闭各会话里该子会话的侧边对话标签，其他标签不动', () => {
    const closed: string[] = []
    const tabs: Record<string, Array<{ id: string; kind: string; contentId: string }>> = {
      p: [
        { id: 't1', kind: 'dshws-sidechat', contentId: sidechatAddress('c1', 'p') },
        { id: 't2', kind: 'dshws-sidechat', contentId: sidechatAddress('c2', 'p') },
        { id: 't3', kind: 'browser', contentId: 'https://x' }
      ],
      c2: [{ id: 't4', kind: 'dshws-sidechat', contentId: sidechatAddress('c1') }]
    }
    const right = { tabsIn: (s: string) => tabs[s] ?? [], closeIn: (s: string, id: string) => void closed.push(`${s}/${id}`) }
    const sessions = { list: { getSnapshot: () => ({ phase: 'ready', byId: { p: {}, c1: {}, c2: {} } }), subscribe: () => () => undefined } }
    const host = createSidechatHost({ get: (n) => (n === 'sidebarRight' ? right : n === 'sessions' ? sessions : undefined) }, () => undefined)
    expect(host.closeTabsOf('c1')).toBe(2)
    expect(closed).toEqual(['p/t1', 'c2/t4'])
    expect(createSidechatHost({ get: () => undefined }, () => undefined).closeTabsOf('c1')).toBe(0)
  })
})

describe('threadParentOf / existsIn', () => {
  it('侧边对话本身列兄弟线程；列表就绪前不判删除', () => {
    const recs = [{ parentId: 'p', childId: 'c', createdAt: 1 }]
    expect(threadParentOf(recs, 'c')).toBe('p')
    expect(threadParentOf(recs, 'p')).toBe('p')
    expect(existsIn({ byId: {}, phase: 'pending' })('x')).toBeUndefined()
    expect(existsIn({ byId: {}, phase: 'ready' })('x')).toBe(false)
    expect(existsIn({ byId: { x: { id: 'x' } }, phase: 'pending' })('x')).toBe(true)
  })
})

describe('registerSidechat', () => {
  function fakeCtx(services: Record<string, unknown>) {
    const slots: string[] = []
    const ctx = {
      get: (name: string) => services[name],
      inject(_names: string[], cb: (sub: { get(n: string): unknown; effect(f: () => () => void): unknown }) => void) {
        const disposers: Array<() => void> = []
        cb({ get: (n) => services[n], effect: (f) => disposers.push(f()) })
        return () => disposers.forEach((d) => d())
      },
      slots: {
        inject: (_name: string, f: () => () => void) => f(),
        register: (o: { name: string; key?: string; id?: string }) => {
          const tag = `${o.name}#${o.key ?? o.id ?? ''}`
          slots.push(tag)
          return () => slots.splice(slots.indexOf(tag), 1)
        }
      }
    }
    return { ctx, slots }
  }
  const t = (k: string) => k

  it('按偏好注册 / 撤销；缺 fork 时不出入口', () => {
    const tabsRegistered: string[] = []
    const resources: string[] = []
    const services = {
      sidebarRightTabs: { register: (d: { kind: string }) => (tabsRegistered.push(d.kind), () => tabsRegistered.splice(tabsRegistered.indexOf(d.kind), 1)) },
      resources: { register: (p: { protocol: string }) => (resources.push(p.protocol), () => resources.splice(resources.indexOf(p.protocol), 1)) },
      sessions: { fork: () => undefined, retain: () => undefined }
    }
    const { ctx, slots } = fakeCtx(services)
    const off = registerSidechat(ctx as never, { t, api: fakeApi() }, () => undefined)
    expect(tabsRegistered).toEqual(['dshws-sidechat'])
    expect(resources).toEqual(['dshws-sidechat'])
    expect(slots).toEqual(['sidebar.right.pane.tab#dshws-sidechat', 'dshws.sidechat.conversation#', 'conversation.session.header.utilities#dshws-sidechat'])
    setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { tabs: { sidechat: false } }))
    expect([tabsRegistered, resources, slots]).toEqual([[], [], []])
    setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { tabs: { sidechat: true } }))
    expect(tabsRegistered).toEqual(['dshws-sidechat'])
    off()
    expect(slots).toEqual([])

    const bare = fakeCtx({ ...services, sessions: { list: {} } })
    registerSidechat(bare.ctx as never, { t, api: fakeApi() }, () => undefined)
    expect(bare.slots).toEqual([])
  })
})
