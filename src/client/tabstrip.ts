/*
 * @Description: 可横向滚动的页签栏（配合 styles.ts 的 .dshws-tabstrip）—— 窄宽度下页签不换行、可滑动、激活项自动露出
 * @Author: YangHeng
 * @Date: 2026-10-10 17:10:00
 * @FilePath: /dsh-workspace/src/client/tabstrip.ts
 *
 * 为什么需要脚本：样式只能做到「不换行 + overflow-x: auto」，但普通鼠标滚轮只产生纵向 deltaY，
 * 在横向滚动条上滚不动；另外切换页签（含代码触发，如 AI 改动导航）后激活项可能停在可视区外。
 */
import { useCallback, useEffect, useState } from 'react'

/** 纵向滚轮 → 横向位移；返回 null 表示不接管（已是横向手势、按住 Shift/Ctrl、或本来就放得下）。纯函数便于单测。 */
export function wheelToHorizontal(e: { deltaX: number; deltaY: number; shiftKey?: boolean; ctrlKey?: boolean }, scrollWidth: number, clientWidth: number): number | null {
  if (scrollWidth <= clientWidth) return null
  // 触控板横滑自带 deltaX，浏览器原生处理即可；Ctrl+滚轮是缩放、Shift+滚轮浏览器已转横向。
  if (e.ctrlKey === true || e.shiftKey === true) return null
  if (Math.abs(e.deltaX) >= Math.abs(e.deltaY) || e.deltaY === 0) return null
  return e.deltaY
}

/** inline: 'nearest' 的滚动位置：已完整可见不动，否则贴近最近的一侧（比可视区宽时贴左）。 */
export function nearestScrollLeft(scrollLeft: number, clientWidth: number, itemLeft: number, itemWidth: number): number {
  if (itemLeft < scrollLeft || itemWidth > clientWidth) return Math.max(0, itemLeft)
  if (itemLeft + itemWidth > scrollLeft + clientWidth) return itemLeft + itemWidth - clientWidth
  return scrollLeft
}

/**
 * 返回回调 ref（不是 useRef）：页签栏常常是条件渲染的（加载完状态才出现、查看分支时换成另一条），
 * 回调 ref 能在元素真正挂上 / 换掉时重新绑定滚轮监听。
 * @param activeKey 当前激活页签的标识；变化时把 [data-active="true"] 的页签滚进可视区
 */
export function useTabStrip<T extends HTMLElement>(activeKey: unknown): (el: T | null) => void {
  const [el, setEl] = useState<T | null>(null)
  const ref = useCallback((node: T | null) => setEl(node), [])
  useEffect(() => {
    if (el === null) return
    // React 的 onWheel 是被动监听，不能 preventDefault：用原生监听并显式 passive: false。
    const onWheel = (e: WheelEvent): void => {
      const dx = wheelToHorizontal(e, el.scrollWidth, el.clientWidth)
      if (dx === null) return
      e.preventDefault()
      el.scrollLeft += dx
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [el])
  useEffect(() => {
    const active = el?.querySelector<HTMLElement>('[data-active="true"]')
    if (el === null || active === null || active === undefined) return
    // 等价于 scrollIntoView({ inline: 'nearest' })，但只改页签栏自己的 scrollLeft：
    // 原生 scrollIntoView 会连带滚动所有祖先（页签栏不在视口内时会把宿主会话区 / 整页纵向拖动）。
    // 用包围盒换算成「内容坐标」：不依赖 offsetParent 是谁。
    const box = el.getBoundingClientRect()
    const item = active.getBoundingClientRect()
    const next = nearestScrollLeft(el.scrollLeft, el.clientWidth, item.left - box.left - el.clientLeft + el.scrollLeft, item.width)
    if (next !== el.scrollLeft) el.scrollLeft = next
  }, [el, activeKey])
  return ref
}
