/*
 * @Description: 列表行整行可点 —— 行容器当按钮用（role=button、可聚焦、Enter / Space 激活），行内的操作按钮不触发行点击
 * @Author: YangHeng
 * @Date: 2026-10-10 16:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/row-activate.ts
 *
 * 为什么不直接让行里的 <button> 撑满：按钮在块级容器里按内容收缩宽度（提交详情的文件列表就是这样，只能点到文字），
 * 而行里还有「暂存 / 丢弃」等操作按钮，按钮里不能再嵌按钮。所以把行容器本身做成按钮语义，操作按钮的点击 / 按键在这里排除。
 */
import type { KeyboardEvent, MouseEvent } from 'react'

/** 行内这些元素自己处理交互，点击 / 按键不当作整行激活。 */
const INTERACTIVE = 'button, a, input, select, textarea, [role="button"], [role="checkbox"], [role="switch"]'

interface ClosestTarget {
  closest?(selector: string): unknown
}

/** 事件是否来自行内的其他可交互元素（而不是行本身或行内的纯展示内容）。 */
export function fromNestedControl(target: unknown, row: unknown): boolean {
  const hit = (target as ClosestTarget | null)?.closest?.(INTERACTIVE)
  return hit !== null && hit !== undefined && hit !== row
}

/** 与原生按钮一致：Enter 与 Space 激活。 */
export function isActivationKey(key: string): boolean {
  return key === 'Enter' || key === ' ' || key === 'Spacebar'
}

/** 行容器的按钮属性：展开到行的 div 上即可。 */
export function rowButtonProps(onActivate: () => void): {
  role: 'button'
  tabIndex: number
  onClick(e: MouseEvent<HTMLElement>): void
  onKeyDown(e: KeyboardEvent<HTMLElement>): void
} {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: (e) => {
      if (fromNestedControl(e.target, e.currentTarget)) return
      onActivate()
    },
    onKeyDown: (e) => {
      // 焦点在行内操作按钮上时按 Enter / Space 是操作按钮自己的事。
      if (e.target !== e.currentTarget || !isActivationKey(e.key)) return
      // Space 默认会滚动列表，Enter 在某些容器里会提交表单，都要拦下。
      e.preventDefault()
      onActivate()
    }
  }
}
