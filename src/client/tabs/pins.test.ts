/*
 * @Description: 固定标签纯逻辑测试 —— 窗格顺序、关闭目标（跳过固定）、可固定判断、补开计划、重排计划、关闭即取消固定、CSS 生成、存储
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/pins.test.ts
 */
import { describe, expect, it } from 'vitest'
import { asLayout, dockPaneIds, type LayoutLike, type TabRecordLike } from './host-layout.js'
import {
  PINS_KEY_PREFIX,
  closeTargets,
  closeTargetsFlat,
  closedPins,
  loadPins,
  normalizePins,
  pinCss,
  pinKey,
  pinnability,
  pinnedTabIds,
  planReopen,
  planReorder,
  presentPinKeys,
  rememberPanes,
  sanitizeParams,
  savePins,
  targetPane,
  type PinEntry
} from './pins.js'

const FILE = 'dsh-workspace:remote-file'
const FILES = 'dsh-workspace:remote-files'

/** 造布局：panes = [[paneId, [tabId...]]]；tab 记录按 id 推出 kind / contentId（见 rec）。 */
function layout(panes: Array<[string, string[]]>, opts: { floats?: Array<[string, string[]]>; expanded?: boolean; split?: boolean } = {}): LayoutLike {
  const nodes: LayoutLike['nodes'] = {}
  const tabs: LayoutLike['tabs'] = {}
  for (const [id, ids] of [...panes, ...(opts.floats ?? [])]) {
    const host = (opts.floats ?? []).some(([f]) => f === id) ? 'float' : 'dock'
    nodes[id] = { kind: 'pane', id, host, tabs: ids, activeTabId: ids[0] }
    for (const t of ids) tabs[t] = rec(t)
  }
  let rootId = panes[0]![0]
  if (panes.length > 1 || opts.split === true) {
    rootId = 'split-1'
    nodes[rootId] = { kind: 'split', id: rootId, children: panes.map(([id]) => id) }
  }
  return { rootId, nodes, floats: (opts.floats ?? []).map(([id]) => id), expanded: opts.expanded ?? true, tabs }
}

/** tabId 约定：g* = 引导页，f:<name> = 文件，p:<kind> = 页面，t* = 终端，其他 = 文件。 */
function rec(id: string): TabRecordLike {
  if (id.startsWith('g')) return { id, kind: 'guide', contentId: 'sidebar://guide' }
  if (id.startsWith('p:')) return { id, kind: id.slice(2), contentId: `sidebar://${id.slice(2)}` }
  if (id.startsWith('t')) return { id, kind: 'terminal', contentId: `sidebar://terminal/${id}` }
  const name = id.startsWith('f:') ? id.slice(2) : id
  return { id, kind: FILE, contentId: `dsh-resource://file/absolute/${name}` }
}
const pinOf = (id: string, extra: Partial<PinEntry> = {}): PinEntry => ({ kind: rec(id).kind, contentId: rec(id).contentId, ...extra })

describe('host-layout 结构读取', () => {
  it('asLayout 认不出形状就返回 undefined；dockPaneIds 按分屏深度优先从左到右', () => {
    expect(asLayout(undefined)).toBeUndefined()
    expect(asLayout({ rootId: 'x', nodes: {}, tabs: {} })).toBeUndefined()
    const l = layout([['A', ['a']], ['B', ['b']]], { floats: [['F', ['c']]] })
    expect(asLayout(l)).toBeDefined()
    expect(dockPaneIds(l)).toEqual(['A', 'B'])
  })
})

describe('关闭目标', () => {
  const l = layout([['A', ['a', 'b', 'c', 'd', 'e']], ['B', ['x', 'y']]])
  it('只在该标签所在窗格内计算，跳过固定标签', () => {
    const pinned = new Set(['a', 'd'])
    expect(closeTargets(l, 'c', 'left', pinned)).toEqual(['b'])
    expect(closeTargets(l, 'c', 'right', pinned)).toEqual(['e'])
    expect(closeTargets(l, 'c', 'others', pinned)).toEqual(['b', 'e'])
    expect(closeTargets(l, 'c', 'all', pinned)).toEqual(['b', 'c', 'e'])
    expect(closeTargets(l, 'x', 'all', pinned)).toEqual(['x', 'y'])
  })
  it('目标标签本身固定时「全部」不含它；没有可关闭目标返回空（菜单项禁用）', () => {
    expect(closeTargets(l, 'a', 'all', new Set(['a']))).toEqual(['b', 'c', 'd', 'e'])
    expect(closeTargets(l, 'a', 'left', new Set())).toEqual([])
    expect(closeTargets(l, 'b', 'left', new Set(['a']))).toEqual([])
    expect(closeTargets(l, 'missing', 'all', new Set())).toEqual([])
  })
  it('浮窗里的标签同样按自己的窗格计算', () => {
    const f = layout([['A', ['a']]], { floats: [['F', ['m', 'n']]] })
    expect(closeTargets(f, 'n', 'left', new Set())).toEqual(['m'])
  })
  it('降级：按会话全体计算其他 / 全部', () => {
    const tabs = ['a', 'b', 'c'].map(rec)
    expect(closeTargetsFlat(tabs, 'b', 'others', new Set(['a']))).toEqual(['c'])
    expect(closeTargetsFlat(tabs, 'b', 'all', new Set())).toEqual(['a', 'b', 'c'])
  })
})

describe('可固定判断', () => {
  it('资源地址与单例页面可固定', () => {
    expect(pinnability(rec('f:x'))).toEqual({ ok: true })
    expect(pinnability(rec(`p:${FILES}`))).toEqual({ ok: true })
  })
  it('multiple：地址带 uuid、已知 kind、注册表标记 multiple 都不能固定', () => {
    expect(pinnability(rec('t1'))).toEqual({ ok: false, reason: 'multiple' })
    expect(pinnability({ kind: 'browser', contentId: 'sidebar://browser' })).toEqual({ ok: false, reason: 'multiple' })
    expect(pinnability({ kind: 'dsh-workspace:ssh', contentId: 'sidebar://dsh-workspace:ssh' })).toEqual({ ok: false, reason: 'multiple' })
    expect(pinnability({ kind: 'x', contentId: 'sidebar://x' }, (k) => k === 'x')).toEqual({ ok: false, reason: 'multiple' })
    expect(pinnability({ kind: 'y', contentId: 'sidebar://y/abc' })).toEqual({ ok: false, reason: 'multiple' })
  })
  it('引导页与无法重开的地址不支持', () => {
    expect(pinnability(rec('g1'))).toEqual({ ok: false, reason: 'unsupported' })
    expect(pinnability({ kind: 'z', contentId: 'other://z' })).toEqual({ ok: false, reason: 'unsupported' })
  })
})

describe('补开计划', () => {
  it('缺失的固定项补开到记住的窗格；窗格 id 不在时按序号，越界取最右，都没有取最左', () => {
    const l = layout([['A', ['a']], ['B', ['b']]])
    expect(targetPane(l, { paneId: 'B' })).toBe('B')
    expect(targetPane(l, { paneId: 'gone', paneIndex: 1 })).toBe('B')
    expect(targetPane(l, { paneIndex: 5 })).toBe('B')
    expect(targetPane(l, {})).toBe('A')
    const ops = planReopen(l, [pinOf('f:x', { paneIndex: 1 }), pinOf('a')])
    expect(ops).toEqual([{ pin: pinOf('f:x', { paneIndex: 1 }), paneId: 'B' }])
  })
  it('已存在（另一个窗格或浮窗）一律跳过 —— 分屏下只出现一个', () => {
    const l = layout([['A', ['a']], ['B', ['b']]], { floats: [['F', ['c']]] })
    expect(planReopen(l, [pinOf('b', { paneId: 'A' }), pinOf('c', { paneId: 'A' })])).toEqual([])
  })
  it('目标窗格只有引导页时顶替它（只顶替一次）；不可重开的固定项跳过', () => {
    const l = layout([['A', ['g1']]])
    const ops = planReopen(l, [pinOf('f:x'), pinOf('f:y'), pinOf('t9')])
    expect(ops.map((o) => [o.pin.contentId, o.paneId, o.replaceTab])).toEqual([
      ['dsh-resource://file/absolute/x', 'A', 'g1'],
      ['dsh-resource://file/absolute/y', 'A', undefined]
    ])
  })
})

describe('重排计划', () => {
  it('固定标签按固定先后排到窗格最左；逐个计算插入位', () => {
    const l = layout([['A', ['a', 'b', 'c', 'd']]])
    const ops = planReorder(l, [pinOf('d'), pinOf('b')])
    expect(ops).toEqual([
      { tabId: 'd', paneId: 'A', index: 0 },
      { tabId: 'b', paneId: 'A', index: 1 }
    ])
  })
  it('顺序已正确时不发任何动作；浮窗不排；多个窗格各排各的', () => {
    expect(planReorder(layout([['A', ['d', 'b', 'a']]]), [pinOf('d'), pinOf('b')])).toEqual([])
    expect(planReorder(layout([['A', ['a']]], { floats: [['F', ['x', 'y']]] }), [pinOf('y')])).toEqual([])
    const l = layout([['A', ['a', 'b']], ['B', ['x', 'y']]])
    expect(planReorder(l, [pinOf('y'), pinOf('b')])).toEqual([
      { tabId: 'b', paneId: 'A', index: 0 },
      { tabId: 'y', paneId: 'B', index: 0 }
    ])
  })
  it('同一内容出现两次只认第一个', () => {
    const l = layout([['A', ['a', 'f:x']], ['B', ['b', 'x']]])
    // f:x 与 x 是同一内容（同 kind、同 contentId）：只认停靠窗格从左数第一个。
    expect([...pinnedTabIds(l, [pinOf('x')]).keys()]).toEqual(['f:x'])
  })
})

describe('记住窗格', () => {
  it('固定标签被拖到另一窗格后记住新窗格；没变化返回原数组', () => {
    const pins = [pinOf('b', { paneId: 'A', paneIndex: 0 })]
    const l = layout([['A', ['a']], ['B', ['b']]])
    const next = rememberPanes(l, pins)
    expect(next).not.toBe(pins)
    expect(next[0]).toMatchObject({ paneId: 'B', paneIndex: 1 })
    expect(rememberPanes(l, next)).toBe(next)
  })
  it('在浮窗里保留原记忆', () => {
    const pins = [pinOf('c', { paneId: 'A', paneIndex: 0 })]
    expect(rememberPanes(layout([['A', ['a']]], { floats: [['F', ['c']]] }), pins)).toBe(pins)
  })
})

describe('关闭即取消固定', () => {
  const pins = [pinOf('a'), pinOf('b')]
  it('上次存在、这次消失 → 取消固定', () => {
    const before = presentPinKeys(layout([['A', ['a', 'b', 'c']]]), pins)
    expect(closedPins(before, layout([['A', ['b', 'c']]]), pins)).toEqual([pinKey(pinOf('a'))])
  })
  it('布局未加载、首次观察（刷新 / 切换会话后）都不判', () => {
    const before = presentPinKeys(layout([['A', ['a', 'b']]]), pins)
    expect(closedPins(before, undefined, pins)).toEqual([])
    expect(closedPins(undefined, layout([['A', ['c']]]), pins)).toEqual([])
  })
  it('从没出现过的固定项（等补开）不判；挪到别的窗格不判', () => {
    const before = presentPinKeys(layout([['A', ['a']]]), pins)
    expect(closedPins(before, layout([['A', ['c']], ['B', ['a']]]), pins)).toEqual([])
  })
})

describe('CSS 与存储', () => {
  it('按会话与 tabId 生成隐藏关闭按钮的规则，并转义引号', () => {
    expect(pinCss('s1', ['t1', 'a"b'])).toBe(
      '[data-sidebar-right-session="s1"] [data-dockkit-tab-close="t1"]{display:none!important}\n' +
        '[data-sidebar-right-session="s1"] [data-dockkit-tab-close="a\\"b"]{display:none!important}'
    )
    expect(pinCss('s1', [])).toBe('')
  })
  it('按会话独立存储；空表删键；坏数据回空表；同内容去重', () => {
    const map = new Map<string, string>()
    const storage = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) }
    savePins(storage, 's1', [pinOf('a', { params: { reveal: '/x' }, title: 'A', paneIndex: 0 })])
    expect(loadPins(storage, 's1')).toEqual([pinOf('a', { params: { reveal: '/x' }, title: 'A', paneIndex: 0 })])
    expect(loadPins(storage, 's2')).toEqual([])
    savePins(storage, 's1', [])
    expect(map.has(`${PINS_KEY_PREFIX}s1`)).toBe(false)
    map.set(`${PINS_KEY_PREFIX}s3`, '{bad')
    expect(loadPins(storage, 's3')).toEqual([])
    expect(normalizePins([pinOf('a'), pinOf('a'), { kind: '' }, 1])).toEqual([pinOf('a')])
  })
  it('params 只保留可 JSON 往返且不太大的部分', () => {
    expect(sanitizeParams(undefined)).toBeUndefined()
    expect(sanitizeParams({})).toBeUndefined()
    expect(sanitizeParams({ reveal: '/a', fn: () => 1 })).toEqual({ reveal: '/a' })
    expect(sanitizeParams({ big: 'x'.repeat(5000) })).toBeUndefined()
  })
})
