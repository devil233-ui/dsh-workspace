/*
 * @Description: 远程会话终端接管的测试 —— 远程 / 本机分支、偏好开关、导航参数解析、插槽注册与卡片透传
 * @Author: YangHeng
 * @Date: 2026-10-10 15:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/terminal-takeover.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { DEFAULT_SIDEBAR_PREFS, mergeSidebarPrefs } from '../../wire/sidebar-prefs.js'
import { getSidebarPrefs, setSidebarPrefs } from '../sidebar-prefs.js'
import { RemoteIndex } from './remote-index.js'
import { SSH_ID } from './kinds.js'
import {
  GUIDE_ENTRY_SLOT,
  HOST_TERMINAL_PROVIDER,
  SSH_SHELL_ID,
  TAKEOVER_PRIORITY,
  TerminalGuideOverride,
  findHostGuide,
  parseSshParams,
  registerSshTabType,
  registerTerminalTakeover,
  sshGuideShown,
  sshParamsFor,
  sshTarget,
  takeoverWanted,
  terminalRoute,
  type SlotEntryLike
} from './terminal-takeover.js'

const ws = { localPath: 'C:\\ph\\app', hostId: 'h1', remotePath: '/srv/app', title: 'app' }
const sessions = {
  list: { getSnapshot: () => ({ byId: { remote: { cwd: 'C:\\ph\\app\\sub' }, local: { cwd: '/Users/me/proj' } } }), subscribe: () => () => undefined }
}
const t = ((k: string, v?: Record<string, string>) => (v === undefined ? k : `${k}:${Object.values(v).join('|')}`)) as never
const api = { call: async () => ({ hosts: [{ id: 'h1', label: 'prod', hostname: '10.0.0.1' }] }) } as never

afterEach(() => setSidebarPrefs(DEFAULT_SIDEBAR_PREFS))

describe('分支判断', () => {
  it('远程工作区会话走 SSH；本机会话、列表未加载、接管关闭都走宿主终端', () => {
    expect(terminalRoute(true, ws)).toEqual({ kind: 'ssh', workspace: ws })
    expect(terminalRoute(true, undefined)).toEqual({ kind: 'host' })
    expect(terminalRoute(false, ws)).toEqual({ kind: 'host' })
  })

  it('偏好：默认开；关掉「远程工作区使用插件 SSH 终端」或 SSH 标签都不接管', () => {
    expect(takeoverWanted(DEFAULT_SIDEBAR_PREFS)).toBe(true)
    expect(takeoverWanted(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { remoteSshTerminal: false }))).toBe(false)
    expect(takeoverWanted(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { tabs: { ssh: false } }))).toBe(false)
  })

  it('台账里找「没有本插件时会渲染」的宿主卡片：同 key、跳过自身与其他 key', () => {
    const self = () => null
    const host = () => null
    const entries: SlotEntryLike[] = [
      { component: self as never, options: { key: HOST_TERMINAL_PROVIDER, priority: -100 } },
      { component: (() => null) as never, options: { key: 'other' } },
      { component: host as never, options: { key: HOST_TERMINAL_PROVIDER } }
    ]
    expect(findHostGuide(entries, self)?.component).toBe(host)
    expect(findHostGuide(entries.slice(0, 2), self)).toBeUndefined()
  })
})

describe('导航参数', () => {
  it('parseSshParams：只收合法字段（hostId 非空、cwd 必须是绝对路径），其余丢弃', () => {
    expect(parseSshParams(undefined)).toEqual({})
    expect(parseSshParams([1])).toEqual({})
    expect(parseSshParams({ hostId: 'h2', cwd: '/home/a', title: 'x', extra: 1 })).toEqual({ hostId: 'h2', cwd: '/home/a', title: 'x' })
    expect(parseSshParams({ hostId: ' ', cwd: 'rel/dir', title: 3 })).toEqual({})
    expect(parseSshParams({ hostId: 'x'.repeat(201) })).toEqual({})
  })

  it('sshTarget：有 hostId 用它（同主机时补工作区目录）；没有则用当前远程工作区；本机会话无 hostId → undefined', () => {
    expect(sshTarget({}, ws)).toEqual({ hostId: 'h1', cwd: '/srv/app', title: 'app' })
    expect(sshTarget({}, undefined)).toBeUndefined()
    expect(sshTarget({ hostId: 'h2' }, undefined)).toEqual({ hostId: 'h2' })
    expect(sshTarget({ hostId: 'h2', cwd: '/tmp' }, ws)).toEqual({ hostId: 'h2', cwd: '/tmp' })
    expect(sshTarget({ hostId: 'h1' }, ws)).toEqual({ hostId: 'h1', cwd: '/srv/app', title: 'app' })
    expect(sshTarget(parseSshParams(sshParamsFor(ws)), undefined)).toEqual({ hostId: 'h1', cwd: '/srv/app', title: 'app' })
  })
})

/** 记录渲染时收到的 props 的宿主卡片替身。 */
function hostStub() {
  const seen: Array<Record<string, unknown>> = []
  const Host = (p: Record<string, unknown>) => {
    seen.push(p)
    ;(p.useShortcuts as (s: unknown) => unknown)(() => 'k')
    ;(p.useTabInfo as () => unknown)()
    return createElement('div', null, String(p.title))
  }
  return { Host, seen }
}

async function indexReady() {
  const index = new RemoteIndex(async () => [ws], () => sessions as never)
  await index.refresh()
  return index
}

describe('卡片组件', () => {
  it('本机会话：原样把 props 交给宿主组件（文案、Shell 读取、快捷键都是宿主的）', async () => {
    const { Host, seen } = hostStub()
    const loadShells = async () => ({ shells: [] })
    const props = {
      title: '新建终端',
      description: '在会话工作区运行命令',
      kind: 'terminal',
      useTabInfo: () => ({ tab: { actions: { openTab: () => undefined } } }),
      useShortcuts: (s: (e: unknown[]) => unknown) => s([]),
      loadShells,
      selectShell: () => undefined,
      dshws: { host: { component: Host, options: {} }, index: await indexReady(), api, t, sessionId: 'local' }
    }
    expect(renderToStaticMarkup(createElement(TerminalGuideOverride as never, props as never))).toContain('新建终端')
    expect(seen[0]?.title).toBe('新建终端')
    expect(seen[0]?.loadShells).toBe(loadShells)
    expect(seen[0]?.useTabInfo).toBe(props.useTabInfo)
    expect('dshws' in (seen[0] as object)).toBe(false)
  })

  it('远程会话：替换文案与下拉项，点卡片 / 选下拉打开插件 SSH 标签（带主机与工作区目录），不显示快捷键', async () => {
    const { Host, seen } = hostStub()
    const opened: Array<[string, unknown]> = []
    const props = {
      title: '新建终端',
      description: '在会话工作区运行命令',
      useTabInfo: () => ({ tab: { actions: { openTab: (k: string, o: unknown) => opened.push([k, o]) } } }),
      useShortcuts: (s: (e: unknown[]) => unknown) => s([{ id: 'terminal.new' }]),
      loadShells: async () => ({ shells: [{ path: '/bin/bash', name: 'bash' }] }),
      selectShell: () => {
        throw new Error('不应写宿主 Shell 偏好')
      },
      dshws: { host: { component: Host, options: {} }, index: await indexReady(), api, t, sessionId: 'remote' }
    }
    renderToStaticMarkup(createElement(TerminalGuideOverride as never, props as never))
    const p = seen[0] as Record<string, any>
    expect(p.title).toBe('termTakeover.title:app')
    expect(p.description).toBe('termTakeover.desc:/srv/app')
    expect(p.useShortcuts(() => 'x')).toBeUndefined()
    expect(await p.loadShells()).toEqual({ shells: [{ path: SSH_SHELL_ID, name: 'termTakeover.shell:app' }], selectedShell: SSH_SHELL_ID })
    expect(() => p.selectShell(SSH_SHELL_ID)).not.toThrow()
    const tab = p.useTabInfo().tab
    tab.actions.openTab('terminal', { replaceTab: true, params: { shellPath: SSH_SHELL_ID } })
    tab.actions.openTab('browser', { replaceTab: true })
    expect(opened).toEqual([
      [SSH_ID, { replaceTab: true, params: { hostId: 'h1', cwd: '/srv/app', title: 'app' } }],
      ['browser', { replaceTab: true }]
    ])
  })
})

describe('registerTerminalTakeover', () => {
  function fakeCtx(withLedger = true) {
    const entries: SlotEntryLike[] = []
    const listeners = new Set<() => void>()
    const hostEntry: SlotEntryLike = {
      component: (() => null) as never,
      locale: 'sidebarTerminal',
      inject: (sessionId) => ({ hooks: { shortcuts: {} }, loadShells: `shells:${String(sessionId)}` }),
      options: { key: HOST_TERMINAL_PROVIDER, priority: 0 }
    }
    let declared = true
    const slots = {
      inject: (name: string, f: () => () => void) => {
        expect(name).toBe(GUIDE_ENTRY_SLOT)
        return declared ? f() : () => undefined
      },
      register: (o: { key: string; priority: number; locale: string; inject: (...a: unknown[]) => Record<string, unknown> }, component: unknown) => {
        const e: SlotEntryLike = { component: component as never, inject: o.inject, locale: o.locale, options: { key: o.key, priority: o.priority } }
        entries.push(e)
        entries.sort((a, b) => (a.options.priority ?? 0) - (b.options.priority ?? 0))
        return () => entries.splice(entries.indexOf(e), 1)
      },
      ...(withLedger
        ? {
            entries: () => entries,
            entriesOfSlot: () => entries,
            subscribe: (_n: string, l: () => void) => (listeners.add(l), () => listeners.delete(l))
          }
        : {})
    }
    const notify = () => {
      for (const l of [...listeners]) l()
    }
    return { ctx: { slots } as never, entries, hostEntry, notify, setDeclared: (v: boolean) => (declared = v) }
  }

  it('宿主卡片出现后以更低 priority 注册同 key；inject 转调宿主 inject 并带上会话；偏好关闭即撤销、打开再注册', async () => {
    const f = fakeCtx()
    const logs: string[] = []
    const off = registerTerminalTakeover(f.ctx, { t, api, index: await indexReady() }, (m) => logs.push(m))
    expect(f.entries).toHaveLength(0) // 宿主卡片还没注册：等它
    f.entries.push(f.hostEntry)
    f.notify()
    expect(f.entries.map((e) => e.options.priority)).toEqual([TAKEOVER_PRIORITY, 0])
    const mine = f.entries[0]!
    expect(mine.component).toBe(TerminalGuideOverride)
    expect(mine.locale).toBe('sidebarTerminal')
    const face = mine.inject!('s1') as Record<string, any>
    expect(face.loadShells).toBe('shells:s1')
    expect(face.hooks).toEqual({ shortcuts: {} })
    expect(face.dshws.sessionId).toBe('s1')
    expect(face.dshws.host).toBe(f.hostEntry)
    f.notify() // 自己的注册触发的通知不重复注册
    expect(f.entries).toHaveLength(2)
    setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { remoteSshTerminal: false }))
    expect(f.entries).toEqual([f.hostEntry])
    setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { remoteSshTerminal: true }))
    expect(f.entries).toHaveLength(2)
    off()
    expect(f.entries).toEqual([f.hostEntry])
    expect(logs).toEqual([])
  })

  it('宿主卡片撤下时跟着撤下；被更低 priority 的其他注册占住时记日志', async () => {
    const f = fakeCtx()
    const logs: string[] = []
    f.entries.push({ component: (() => null) as never, registrant: 'other-plugin', options: { key: HOST_TERMINAL_PROVIDER, priority: -500 } })
    f.entries.push(f.hostEntry)
    registerTerminalTakeover(f.ctx, { t, api, index: await indexReady() }, (m) => logs.push(m))
    expect(logs.some((m) => m.includes('other-plugin'))).toBe(true)
    f.entries.splice(0, f.entries.length)
    f.notify()
    expect(f.entries).toHaveLength(0)
  })

  it('宿主插槽没有台账接口：只记日志，不注册也不抛错', async () => {
    const f = fakeCtx(false)
    const logs: string[] = []
    const index = await indexReady()
    expect(() => registerTerminalTakeover(f.ctx, { t, api, index }, (m) => logs.push(m))).not.toThrow()
    expect(logs[0]).toMatch(/跳过/)
  })
})

describe('SSH 终端引导卡片', () => {
  it('接管生效时隐藏，接管关闭或 SSH 标签关闭时显示', () => {
    expect(sshGuideShown(DEFAULT_SIDEBAR_PREFS)).toBe(false)
    expect(sshGuideShown(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { remoteSshTerminal: false }))).toBe(true)
    const tabsOff = mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, {})
    expect(sshGuideShown({ ...tabsOff, tabs: { ...tabsOff.tabs, ssh: false } })).toBe(true)
  })

  it('偏好变化时先撤旧再按新显隐重注册；显隐不变不重注册；撤销后不再注册', () => {
    const calls: string[] = []
    const register = (show: boolean) => {
      calls.push(`reg:${show}`)
      return () => calls.push(`off:${show}`)
    }
    const off = registerSshTabType(register, () => undefined)
    expect(calls).toEqual(['reg:false'])
    setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { remoteSshTerminal: false }))
    expect(calls).toEqual(['reg:false', 'off:false', 'reg:true'])
    setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { remoteSshTerminal: false }))
    expect(calls).toHaveLength(3)
    setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { remoteSshTerminal: true }))
    expect(calls.slice(3)).toEqual(['off:true', 'reg:false'])
    off()
    expect(calls.at(-1)).toBe('off:false')
    setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { remoteSshTerminal: false }))
    expect(calls.at(-1)).toBe('off:false')
  })

  it('重注册抛错只记日志', () => {
    const logs: string[] = []
    let n = 0
    const off = registerSshTabType(() => {
      n += 1
      if (n > 1) throw new Error('dup')
      return () => undefined
    }, (m) => logs.push(m))
    expect(() => setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { remoteSshTerminal: false }))).not.toThrow()
    expect(logs[0]).toMatch(/SSH/)
    off()
  })
})