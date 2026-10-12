/*
 * @Description: 长按手势 —— 纯状态机（计时、移动 / 滚动取消、触发后吞掉随后的 click）+ 列表行用的 React hook
 * @Author: YangHeng
 * @Date: 2026-10-12 10:40:00
 * @FilePath: /dsh-workspace/src/client/sidebar/long-press.ts
 *
 * 为什么单独做状态机：长按最容易出错的是边界 —— 手指微动算不算取消、滚动列表时别误触发、
 * 触发后松手浏览器还会补一个 click（会把详情展开 / 收起）。这些与 DOM 无关，抽出来可用假计时器逐条测试。
 */
import { useEffect, useMemo, useRef, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react'
import type { HoverTimers } from './commit-popover.js'

export interface LongPress {
  /** 按下：开始计时。 */
  down(x: number, y: number): void
  /** 移动：离按下点超过 tolerance 即取消（手指是在滑动 / 准备滚动）。 */
  move(x: number, y: number): void
  /** 松开：未到时间则取消（短按交给原来的 click）。 */
  up(): void
  /** 外部取消：页面滚动、pointercancel（浏览器接管了手势）。 */
  cancel(): void
  /** 是否正在按住（计时中）。 */
  pressing(): boolean
  /** 随后到来的 click 是否属于刚触发的长按：是则返回 true 并复位，调用方应吞掉这个 click。 */
  consumeClick(): boolean
  dispose(): void
}

const realTimers: HoverTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
}

export function createLongPress(onLongPress: () => void, opt: { delay?: number; tolerance?: number; timers?: HoverTimers } = {}): LongPress {
  const delay = opt.delay ?? 500
  const tolerance = opt.tolerance ?? 10
  const timers = opt.timers ?? realTimers
  let timer: unknown = null
  let startX = 0
  let startY = 0
  let fired = false

  const stop = (): void => {
    if (timer !== null) timers.clear(timer)
    timer = null
  }

  return {
    down(x, y) {
      stop()
      // 新手势开始：上一次长按若没等到 click（有的浏览器长按后不补 click），这里复位，免得误吞这次短按。
      fired = false
      startX = x
      startY = y
      timer = timers.set(() => {
        timer = null
        fired = true
        onLongPress()
      }, delay)
    },
    move(x, y) {
      if (timer === null) return
      if (Math.hypot(x - startX, y - startY) > tolerance) stop()
    },
    up: stop,
    cancel: stop,
    pressing: () => timer !== null,
    consumeClick() {
      if (!fired) return false
      fired = false
      return true
    },
    dispose: stop
  }
}

/** 绑到列表行上的事件处理（React 合成事件）。 */
export interface LongPressHandlers {
  onPointerDown(e: ReactPointerEvent<HTMLElement>): void
  onPointerMove(e: ReactPointerEvent<HTMLElement>): void
  onPointerUp(): void
  onPointerCancel(): void
  onContextMenu(e: ReactMouseEvent<HTMLElement>): void
  onClickCapture(e: ReactMouseEvent<HTMLElement>): void
}

/** 按住期间写在行上的属性：样式里据此关掉文字选中（见 styles.ts 的 .dshws-git-commit-row[data-pressing]）。 */
export const PRESSING_ATTR = 'data-pressing'

/**
 * 列表用长按 hook：整张列表共用一个状态机（同一时间只会按住一行），bind(key) 给某一行生成处理函数。
 * enabled = false 时所有处理函数什么都不做（桌面宽屏保留悬停浮窗、右键等原有行为）。
 */
export function useLongPress<K>(onLongPress: (key: K) => void, enabled: boolean, opt: { delay?: number; tolerance?: number } = {}): (key: K) => LongPressHandlers {
  const cb = useRef(onLongPress)
  cb.current = onLongPress
  const key = useRef<K | null>(null)
  const el = useRef<HTMLElement | null>(null)
  const { delay, tolerance } = opt
  const lp = useMemo(
    () =>
      createLongPress(
        () => {
          if (key.current !== null) cb.current(key.current)
        },
        { ...(delay !== undefined ? { delay } : {}), ...(tolerance !== undefined ? { tolerance } : {}) }
      ),
    [delay, tolerance]
  )

  useEffect(() => {
    const release = (): void => {
      el.current?.removeAttribute(PRESSING_ATTR)
      el.current = null
    }
    if (!enabled) {
      lp.cancel()
      release()
      return () => lp.dispose()
    }
    // 列表（或页面）一滚动就说明用户在拖动而不是长按；捕获阶段才能收到任意滚动容器的 scroll。
    const onScroll = (): void => {
      if (!lp.pressing()) return
      lp.cancel()
      release()
    }
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('scroll', onScroll, true)
      lp.dispose()
      release()
    }
  }, [lp, enabled])

  return (k: K): LongPressHandlers => {
    const end = (): void => {
      lp.up()
      el.current?.removeAttribute(PRESSING_ATTR)
      el.current = null
    }
    return {
      onPointerDown(e) {
        if (!enabled) return
        // 鼠标只认左键：右键 / 中键按住不该打开弹窗。
        if (e.pointerType === 'mouse' && e.button !== 0) return
        key.current = k
        el.current = e.currentTarget
        e.currentTarget.setAttribute(PRESSING_ATTR, 'true')
        lp.down(e.clientX, e.clientY)
      },
      onPointerMove(e) {
        if (!enabled || !lp.pressing()) return
        lp.move(e.clientX, e.clientY)
        if (!lp.pressing()) end()
      },
      onPointerUp: end,
      onPointerCancel() {
        lp.cancel()
        end()
      },
      onContextMenu(e) {
        // 移动端长按会弹系统菜单（Android 的「复制 / 分享」等），与长按弹窗抢手势；这里一律拦下。
        if (enabled) e.preventDefault()
      },
      onClickCapture(e) {
        if (!enabled || !lp.consumeClick()) return
        // 长按松手后浏览器补发的 click：吞掉，否则会顺带展开 / 收起该提交的详情。
        e.preventDefault()
        e.stopPropagation()
      }
    }
  }
}
