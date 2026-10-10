/*
 * @Description: 整行可点的测试 —— Enter / Space 激活、行内操作按钮不触发、点击行内纯展示内容触发
 * @Author: YangHeng
 * @Date: 2026-10-10 16:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/row-activate.test.ts
 */
import { describe, expect, it } from 'vitest'
import { fromNestedControl, isActivationKey, rowButtonProps } from './row-activate.js'

/** 极简元素：closest 按预设返回命中的可交互祖先。 */
const el = (interactiveAncestor: unknown = null) => ({ closest: () => interactiveAncestor })

describe('rowButtonProps', () => {
  it('按钮语义：role=button 且可聚焦', () => {
    const p = rowButtonProps(() => undefined)
    expect(p.role).toBe('button')
    expect(p.tabIndex).toBe(0)
  })

  it('行获得焦点时 Enter / Space 激活并阻止默认行为，其他键忽略', () => {
    let n = 0
    const p = rowButtonProps(() => (n += 1))
    const row = el()
    for (const key of ['Enter', ' ']) {
      let prevented = false
      p.onKeyDown({ key, target: row, currentTarget: row, preventDefault: () => (prevented = true) } as never)
      expect(prevented, key).toBe(true)
    }
    p.onKeyDown({ key: 'a', target: row, currentTarget: row, preventDefault: () => undefined } as never)
    p.onKeyDown({ key: 'Tab', target: row, currentTarget: row, preventDefault: () => undefined } as never)
    expect(n).toBe(2)
  })

  it('焦点在行内操作按钮上时按键交给按钮自己', () => {
    let n = 0
    const p = rowButtonProps(() => (n += 1))
    p.onKeyDown({ key: 'Enter', target: el(), currentTarget: el(), preventDefault: () => undefined } as never)
    expect(n).toBe(0)
  })

  it('点击行内任意展示内容都激活；点击行内操作按钮不激活', () => {
    let n = 0
    const p = rowButtonProps(() => (n += 1))
    const row = el()
    // 点在文件名 / 空白处：最近的可交互祖先就是行自己。
    p.onClick({ target: el(row), currentTarget: row } as never)
    p.onClick({ target: row, currentTarget: row } as never)
    expect(n).toBe(2)
    // 点在「暂存」「丢弃」等按钮上。
    p.onClick({ target: el({ tag: 'button' }), currentTarget: row } as never)
    expect(n).toBe(2)
  })
})

describe('辅助判断', () => {
  it('isActivationKey 与原生按钮一致', () => {
    expect(isActivationKey('Enter')).toBe(true)
    expect(isActivationKey(' ')).toBe(true)
    expect(isActivationKey('Spacebar')).toBe(true)
    expect(isActivationKey('Escape')).toBe(false)
  })

  it('fromNestedControl：没有 closest 的目标（文本节点等）不算行内控件', () => {
    expect(fromNestedControl({}, {})).toBe(false)
    expect(fromNestedControl(null, {})).toBe(false)
  })
})
