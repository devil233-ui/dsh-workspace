/*
 * @Description: Git「历史」提交说明浮窗的纯逻辑 —— 视口内定位（避让边界）与悬停计时状态机
 * @Author: YangHeng
 * @Date: 2026-10-10 18:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/commit-popover.ts
 *
 * 为什么单独成文件：这两块是浮窗里最容易出错的部分（边界翻转、移入浮窗不消失），与 React / DOM 无关，
 * 抽成纯函数 + 小状态机后可以用假计时器逐条测试，组件只负责把事件转发进来。
 */

export interface Rect {
  left: number
  top: number
  right: number
  bottom: number
}

export interface Size {
  width: number
  height: number
}

export interface Placement {
  left: number
  top: number
  side: 'left' | 'bottom' | 'top' | 'right'
}

/** 浮窗首选方向：右侧栏里用 'left'（伸进主区），会话顶部标签页（主区）里用 'right'（伸进右侧详情区）。 */
export type PopoverSide = 'left' | 'right'

/**
 * 计算浮窗位置（position: fixed 的 left / top）。
 * prefer = 'left'（默认，右侧栏）：左侧 → 下方 → 上方 → 右侧。右侧栏贴屏幕右边，左边通常是大片主区。
 * prefer = 'right'（主区会话顶部标签）：右侧 → 左侧 → 下方 → 上方。列表在左、详情在右，右边空间大；
 * 为什么右侧放不下先退左侧而不是下方：左右放置不会盖住相邻的提交行，比上下更不挡视线。
 * 都放不下时选上下空间大的一侧并收进视口。
 * 下方 / 上方时贴首选方向的那条边：左侧优先时右边缘与行右边缘对齐（浮窗常比窄侧栏宽，向左伸进主区比顶出屏幕右边好），
 * 右侧优先时左边缘与行左边缘对齐（主区列表靠左，向右伸展）。
 */
export function placeCommitPopover(anchor: Rect, size: Size, viewport: Size, opt: { gap?: number; margin?: number; prefer?: PopoverSide } = {}): Placement {
  const gap = opt.gap ?? 6
  const margin = opt.margin ?? 8
  const prefer = opt.prefer ?? 'left'
  const { width: w, height: h } = size
  // 先 min 再 max：浮窗比视口还大时贴住 margin，而不是给出负坐标。
  const clampX = (x: number): number => Math.max(margin, Math.min(x, viewport.width - margin - w))
  const clampY = (y: number): number => Math.max(margin, Math.min(y, viewport.height - margin - h))
  const vx = clampX(prefer === 'left' ? anchor.right - w : anchor.left)

  const left = (): Placement | null => (anchor.left - gap - w >= margin ? { left: anchor.left - gap - w, top: clampY(anchor.top), side: 'left' } : null)
  const right = (): Placement | null => (anchor.right + gap + w <= viewport.width - margin ? { left: anchor.right + gap, top: clampY(anchor.top), side: 'right' } : null)
  const bottom = (): Placement | null => (anchor.bottom + gap + h <= viewport.height - margin ? { left: vx, top: anchor.bottom + gap, side: 'bottom' } : null)
  const top = (): Placement | null => (anchor.top - gap - h >= margin ? { left: vx, top: anchor.top - gap - h, side: 'top' } : null)
  const order = prefer === 'left' ? [left, bottom, top, right] : [right, left, bottom, top]
  for (const tryPlace of order) {
    const p = tryPlace()
    if (p !== null) return p
  }
  const below = viewport.height - anchor.bottom
  return below >= anchor.top
    ? { left: vx, top: clampY(anchor.bottom + gap), side: 'bottom' }
    : { left: vx, top: clampY(anchor.top - gap - h), side: 'top' }
}

export interface HoverTimers {
  set(fn: () => void, ms: number): unknown
  clear(id: unknown): void
}

export interface HoverIntent<K> {
  /** 鼠标移入 / 键盘聚焦某一行：showDelay 后显示该行的浮窗。 */
  enter(key: K): void
  /** 移出 / 失焦：取消待显示；已显示的在 hideDelay 后隐藏（期间移入浮窗则保持）。 */
  leave(): void
  enterPopover(): void
  leavePopover(): void
  /** 主动打开（移动端长按 / 「说明」按钮，以居中弹窗显示）：立即显示并固定，悬停进出不再影响，直到 close。 */
  open(key: K): void
  /** 立即关闭（Esc / 滚动 / 点外面）。 */
  close(): void
  current(): K | null
  pinned(): boolean
  dispose(): void
}

const realTimers: HoverTimers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>)
}

/**
 * 悬停意图状态机：同一时间只显示一个浮窗。
 * 为什么移到另一行时不立刻切换：浮窗放在行下方时，鼠标去浮窗的路上会经过下一行，立刻切换会让用户永远够不着浮窗；
 * 这里改为「旧浮窗按 hideDelay 收起、新行照常等 showDelay」，路过的行只要在 hideDelay 内进到浮窗就会被取消。
 */
export function createHoverIntent<K>(onChange: (key: K | null) => void, opt: { showDelay?: number; hideDelay?: number; timers?: HoverTimers } = {}): HoverIntent<K> {
  const showDelay = opt.showDelay ?? 400
  const hideDelay = opt.hideDelay ?? 150
  const timers = opt.timers ?? realTimers
  let shown: K | null = null
  let showTimer: unknown = null
  let hideTimer: unknown = null
  let inPopover = false
  let isPinned = false

  const clearShow = (): void => {
    if (showTimer !== null) timers.clear(showTimer)
    showTimer = null
  }
  const clearHide = (): void => {
    if (hideTimer !== null) timers.clear(hideTimer)
    hideTimer = null
  }
  const setShown = (key: K | null): void => {
    // 浮窗卸载时不会再收到 pointerleave，这里顺手复位，避免下一个浮窗被误判为「鼠标在里面」。
    if (key === null) inPopover = false
    if (shown === key) return
    shown = key
    onChange(key)
  }
  const scheduleHide = (): void => {
    clearHide()
    if (shown === null) return
    hideTimer = timers.set(() => {
      hideTimer = null
      setShown(null)
    }, hideDelay)
  }

  return {
    enter(key) {
      if (isPinned) return
      clearShow()
      // 只有回到已显示的那一行才取消收起；换到别的行时旧浮窗照常按 hideDelay 收起（见上方说明）。
      if (shown === key) {
        clearHide()
        return
      }
      showTimer = timers.set(() => {
        showTimer = null
        setShown(key)
      }, showDelay)
    },
    leave() {
      if (isPinned) return
      clearShow()
      if (!inPopover) scheduleHide()
    },
    enterPopover() {
      inPopover = true
      clearHide()
      clearShow()
    },
    leavePopover() {
      inPopover = false
      if (!isPinned) scheduleHide()
    },
    open(key) {
      clearShow()
      clearHide()
      isPinned = true
      setShown(key)
    },
    close() {
      clearShow()
      clearHide()
      isPinned = false
      setShown(null)
    },
    current: () => shown,
    pinned: () => isPinned,
    dispose() {
      clearShow()
      clearHide()
    }
  }
}
