/*
 * @Description: 文件树多选的测试 —— Ctrl 点选、Shift 连选（含反向、追加、锚点不可见）、清理
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/tree-select.test.ts
 */
import { describe, expect, it } from 'vitest'
import { EMPTY_SELECTION, clickSelect, pruneSelection, rangeBetween } from './tree-select.js'

const order = ['/a', '/a/1', '/a/2', '/b', '/c']
const plain = { toggle: false, range: false }
const ctrl = { toggle: true, range: false }
const shift = { toggle: false, range: true }
const ctrlShift = { toggle: true, range: true }
const list = (s: { selected: ReadonlySet<string> }): string[] => [...s.selected].sort()

describe('rangeBetween', () => {
  it('正向与反向都含两端；不在可见行里返回 undefined', () => {
    expect(rangeBetween(order, '/a/1', '/b')).toEqual(['/a/1', '/a/2', '/b'])
    expect(rangeBetween(order, '/b', '/a/1')).toEqual(['/a/1', '/a/2', '/b'])
    expect(rangeBetween(order, '/zzz', '/b')).toBeUndefined()
  })
})

describe('clickSelect', () => {
  it('普通点击：只选这一项并设为锚点', () => {
    const s = clickSelect(EMPTY_SELECTION, order, '/a/2', plain)
    expect(list(s)).toEqual(['/a/2'])
    expect(s.anchor).toBe('/a/2')
  })

  it('Ctrl 点击：切换选中，锚点移过去', () => {
    let s = clickSelect(EMPTY_SELECTION, order, '/a', plain)
    s = clickSelect(s, order, '/c', ctrl)
    expect(list(s)).toEqual(['/a', '/c'])
    s = clickSelect(s, order, '/a', ctrl)
    expect(list(s)).toEqual(['/c'])
    expect(s.anchor).toBe('/a')
  })

  it('Shift 点击：从锚点连选并替换，锚点不动；连续 Shift 以同一锚点计算', () => {
    let s = clickSelect(EMPTY_SELECTION, order, '/a/1', plain)
    s = clickSelect(s, order, '/c', shift)
    expect(list(s)).toEqual(['/a/1', '/a/2', '/b', '/c'])
    expect(s.anchor).toBe('/a/1')
    s = clickSelect(s, order, '/a', shift)
    expect(list(s)).toEqual(['/a', '/a/1'])
  })

  it('Ctrl+Shift：连选追加到已有选择', () => {
    let s = clickSelect(EMPTY_SELECTION, order, '/c', plain)
    s = clickSelect(s, order, '/a', ctrl)
    s = clickSelect(s, order, '/a/2', ctrlShift)
    expect(list(s)).toEqual(['/a', '/a/1', '/a/2', '/c'])
  })

  it('没有锚点或锚点已不可见时，Shift 按普通点击处理', () => {
    expect(list(clickSelect(EMPTY_SELECTION, order, '/b', shift))).toEqual(['/b'])
    const stale = { selected: new Set(['/x/hidden']), anchor: '/x/hidden' }
    expect(list(clickSelect(stale, order, '/b', shift))).toEqual(['/b'])
  })
})

describe('pruneSelection', () => {
  it('去掉不存在的项；没有变化时返回原对象', () => {
    const s = { selected: new Set(['/a', '/gone']), anchor: '/gone' }
    const next = pruneSelection(s, (p) => p !== '/gone')
    expect(list(next)).toEqual(['/a'])
    expect(next.anchor).toBeNull()
    const same = { selected: new Set(['/a']), anchor: '/a' }
    expect(pruneSelection(same, () => true)).toBe(same)
  })
})
