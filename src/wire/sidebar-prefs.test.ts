/*
 * @Description: 「侧边栏」偏好模型的测试 —— 默认值、规范化、局部合并，以及与查看器覆盖值的换算
 * @Author: YangHeng
 * @Date: 2026-10-10 14:00:00
 * @FilePath: /dsh-workspace/src/wire/sidebar-prefs.test.ts
 */
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SIDEBAR_PREFS,
  RETIRED_SIDEBAR_TAB_KEYS,
  SIDEBAR_TAB_KEYS,
  SIDECHATS_MAX,
  addSidechat,
  mergeSidebarPrefs,
  normalizeExt,
  normalizeSidebarPrefs,
  normalizeSidechats,
  removeSidechat,
  sidechatThreads
} from './sidebar-prefs.js'
import { viewerOverridesOf } from '../client/sidebar-prefs.js'
import { mergeViewerPrefs } from '../client/viewers/prefs.js'

describe('normalizeSidebarPrefs', () => {
  it('缺省 / 损坏输入回默认值：标签全开、IME 守卫开、open_in_sidebar 开、任务页自动打开开、20MB、默认沙箱', () => {
    for (const raw of [undefined, null, 'x', [], {}]) expect(normalizeSidebarPrefs(raw)).toEqual(DEFAULT_SIDEBAR_PREFS)
    const d = DEFAULT_SIDEBAR_PREFS
    expect(Object.values(d.tabs).every(Boolean)).toBe(true)
    expect([d.imeGuard, d.openInSidebar, d.tasksAutoOpen, d.htmlNoSandbox, d.largeFileMB, d.associations]).toEqual([true, true, true, false, 20, null])
  })

  it('非法字段逐项回退，阈值夹在范围内，关联过滤非法扩展名与查看器', () => {
    const p = normalizeSidebarPrefs({
      tabs: { git: false, ssh: 'no', bogus: true },
      largeFileMB: 99999,
      imeGuard: 0,
      customCss: 42,
      associations: { '.LOG': { viewer: 'monaco', mode: 'edit' }, 'a/b': { viewer: 'monaco' }, txt: { viewer: 'nope' }, md: { viewer: 'markdown', mode: 'x' } }
    })
    expect(p.tabs.git).toBe(false)
    expect(p.tabs.ssh).toBe(true)
    expect('bogus' in p.tabs).toBe(false)
    expect(p.largeFileMB).toBe(4096)
    expect(p.imeGuard).toBe(true)
    expect(p.customCss).toBe('')
    expect(p.associations).toEqual({ log: { viewer: 'monaco', mode: 'edit' }, md: { viewer: 'markdown' } })
  })

  it('文件树偏好：autoRefresh 默认开；openWith 默认空、非法模板被过滤', () => {
    expect(DEFAULT_SIDEBAR_PREFS.autoRefresh).toBe(true)
    expect(DEFAULT_SIDEBAR_PREFS.openWith).toEqual([])
    const p = normalizeSidebarPrefs({ autoRefresh: false, openWith: [{ name: 'IDEA', template: 'idea://open?file={path}' }, { name: 'x', template: 'file:///{path}' }] })
    expect(p.autoRefresh).toBe(false)
    expect(p.openWith).toEqual([{ name: 'IDEA', template: 'idea://open?file={path}' }])
    expect(mergeSidebarPrefs(p, { openWith: [] }).openWith).toEqual([])
  })

  it('远程工作区使用插件 SSH 终端：默认开，非布尔回默认，可关闭', () => {
    expect(DEFAULT_SIDEBAR_PREFS.remoteSshTerminal).toBe(true)
    expect(normalizeSidebarPrefs({ remoteSshTerminal: 'no' }).remoteSshTerminal).toBe(true)
    expect(normalizeSidebarPrefs({ remoteSshTerminal: false }).remoteSshTerminal).toBe(false)
    expect(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { remoteSshTerminal: false }).remoteSshTerminal).toBe(false)
  })

  it('已取消的底部 dock：残留的 tabs.dock 被丢弃，同一对象里的其他偏好照常保留', () => {
    expect(SIDEBAR_TAB_KEYS).not.toContain('dock')
    expect(RETIRED_SIDEBAR_TAB_KEYS).toContain('dock')
    const p = normalizeSidebarPrefs({ tabs: { dock: false, git: false }, largeFileMB: 12, imeGuard: false })
    expect('dock' in p.tabs).toBe(false)
    expect(p.tabs.git).toBe(false)
    expect([p.largeFileMB, p.imeGuard]).toEqual([12, false])
    // 局部合并时带上 dock 也只是被丢弃。
    const m = mergeSidebarPrefs(p, { tabs: { dock: true, files: false } as never })
    expect('dock' in m.tabs).toBe(false)
    expect(m.tabs.files).toBe(false)
  })

  it('normalizeExt', () => {
    expect(normalizeExt(' .TSX ')).toBe('tsx')
    expect(normalizeExt('a b')).toBeUndefined()
    expect(normalizeExt('')).toBeUndefined()
  })
})

describe('mergeSidebarPrefs', () => {
  it('tabs 局部合并；associations: null 恢复默认表', () => {
    const a = mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { tabs: { sidechat: false }, associations: { log: { viewer: 'monaco' } } })
    expect(a.tabs.sidechat).toBe(false)
    expect(a.tabs.files).toBe(true)
    expect(a.associations).toEqual({ log: { viewer: 'monaco' } })
    const b = mergeSidebarPrefs(a, { tabs: { files: false } })
    expect(b.tabs.sidechat).toBe(false)
    expect(b.associations).toEqual({ log: { viewer: 'monaco' } })
    expect(mergeSidebarPrefs(b, { associations: null }).associations).toBeNull()
  })
})

describe('侧边对话记录（sidechats）', () => {
  it('默认空；非法项丢弃、同一子会话留最新、按创建时间升序', () => {
    expect(DEFAULT_SIDEBAR_PREFS.sidechats).toEqual([])
    const list = normalizeSidechats([
      { parentId: 'p', childId: 'c1', createdAt: 20 },
      { parentId: 'p', childId: 'c1', createdAt: 10 },
      { parentId: 'p', childId: 'c2', createdAt: 5 },
      { parentId: 'p', childId: 'p', createdAt: 1 },
      { parentId: '', childId: 'c3', createdAt: 1 },
      { parentId: 'p', childId: 'c4', createdAt: -1 },
      { parentId: 'p', childId: 'c5' },
      'x'
    ])
    expect(list).toEqual([
      { parentId: 'p', childId: 'c2', createdAt: 5 },
      { parentId: 'p', childId: 'c1', createdAt: 20 }
    ])
    expect(normalizeSidebarPrefs({ sidechats: 'bad' }).sidechats).toEqual([])
  })

  it('超出上限丢最旧的', () => {
    const many = Array.from({ length: SIDECHATS_MAX + 5 }, (_, i) => ({ parentId: 'p', childId: `c${i}`, createdAt: i }))
    const list = normalizeSidechats(many)
    expect(list).toHaveLength(SIDECHATS_MAX)
    expect(list[0]!.childId).toBe('c5')
  })

  it('增删与按父会话过滤（新的在前，已删除的会话不列出，未知状态保留）', () => {
    let list = addSidechat([], { parentId: 'p', childId: 'a', createdAt: 1 })
    list = addSidechat(list, { parentId: 'p', childId: 'b', createdAt: 2 })
    list = addSidechat(list, { parentId: 'q', childId: 'c', createdAt: 3 })
    list = addSidechat(list, { parentId: 'p', childId: 'a', createdAt: 4 })
    expect(list.map((r) => r.childId)).toEqual(['b', 'c', 'a'])
    const exists = (id: string): boolean | undefined => (id === 'b' ? false : id === 'a' ? true : undefined)
    expect(sidechatThreads(list, 'p', exists).map((r) => r.childId)).toEqual(['a'])
    expect(sidechatThreads(list, 'p', () => undefined).map((r) => r.childId)).toEqual(['a', 'b'])
    expect(removeSidechat(list, 'c').map((r) => r.childId)).toEqual(['b', 'a'])
    expect(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { sidechats: list }).sidechats).toHaveLength(3)
  })
})

describe('viewerOverridesOf', () => {
  it('默认表不覆盖；自定义表整体替换（删掉的默认扩展名真正失效）；阈值换算字节；不沙箱取反', () => {
    const def = mergeViewerPrefs(viewerOverridesOf(DEFAULT_SIDEBAR_PREFS))
    expect(def.associations.md?.viewer).toBe('markdown')
    expect(def.largeFileBytes).toBe(20 * 1024 * 1024)
    expect(def.htmlSandbox).toBe(true)
    const custom = mergeViewerPrefs(viewerOverridesOf(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { associations: { log: { viewer: 'monaco' } }, largeFileMB: 5, htmlNoSandbox: true })))
    expect(custom.associations.md).toBeUndefined()
    expect(custom.associations.log?.viewer).toBe('monaco')
    expect(custom.largeFileBytes).toBe(5 * 1024 * 1024)
    expect(custom.htmlSandbox).toBe(false)
  })
})
