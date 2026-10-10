/*
 * @Description: 拓扑图分层布局的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/dag.test.ts
 */
import { describe, expect, it } from 'vitest'
import { layoutDag } from './dag.js'

const opts = { nodeWidth: 100, nodeHeight: 40, gapX: 10, gapY: 20, padding: 0 }

describe('layoutDag', () => {
  it('树：按最长路径分层，层内按父节点位置排序，每层水平居中', () => {
    const l = layoutDag(['r', 'a', 'b', 'a1', 'b1', 'a2'], [
      { from: 'r', to: 'a' },
      { from: 'r', to: 'b' },
      { from: 'b', to: 'b1' },
      { from: 'a', to: 'a1' },
      { from: 'a', to: 'a2' }
    ], opts)
    expect(l.layers).toEqual([['r'], ['a', 'b'], ['a1', 'a2', 'b1']])
    expect(l.width).toBe(3 * 100 + 2 * 10)
    expect(l.height).toBe(3 * 40 + 2 * 20)
    // 第 0 层一个节点居中：(320 - 100) / 2
    expect(l.nodes.r).toEqual({ x: 110, y: 0, layer: 0, order: 0 })
    expect(l.nodes.a).toMatchObject({ x: 55, y: 60, layer: 1 })
    expect(l.nodes.b1).toMatchObject({ x: 220, y: 120, order: 2 })
  })

  it('DAG：多父节点取最深的父 + 1', () => {
    const l = layoutDag(['a', 'b', 'c', 'd'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'a', to: 'd' },
      { from: 'c', to: 'd' }
    ], opts)
    expect(l.nodes.d!.layer).toBe(3)
  })

  it('环被打断、自环 / 悬空 / 重复边被丢弃，不会死循环', () => {
    const l = layoutDag(['a', 'b', 'c'], [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'a' },
      { from: 'a', to: 'a' },
      { from: 'a', to: 'ghost' },
      { from: 'a', to: 'b' }
    ], opts)
    expect(l.edges).toEqual([{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }])
    expect(l.layers).toEqual([['a'], ['b'], ['c']])
  })

  it('空图与孤立节点', () => {
    expect(layoutDag([], [], opts)).toMatchObject({ layers: [], width: 0, height: 0 })
    const l = layoutDag(['x', 'y'], [], opts)
    expect(l.layers).toEqual([['x', 'y']])
  })

  it('深链不爆栈', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `n${i}`)
    const edges = ids.slice(1).map((id, i) => ({ from: ids[i]!, to: id }))
    expect(layoutDag(ids, edges, opts).layers).toHaveLength(5000)
  })
})
