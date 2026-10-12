import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHoverIntent, placeCommitPopover } from './commit-popover.js'

const VP = { width: 1280, height: 800 }
const POP = { width: 420, height: 300 }
/** 右侧栏里的一行：x 960..1280。 */
const row = (top: number, left = 960, right = 1280) => ({ left, right, top, bottom: top + 28 })

describe('placeCommitPopover', () => {
  it('左侧放得下时放在行左侧，顶边与行对齐', () => {
    expect(placeCommitPopover(row(100), POP, VP)).toEqual({ left: 960 - 6 - 420, top: 100, side: 'left' })
  })

  it('左侧时纵向收进视口（靠近底部的行不顶出屏幕）', () => {
    const p = placeCommitPopover(row(700), POP, VP)
    expect(p.side).toBe('left')
    expect(p.top).toBe(800 - 8 - 300)
  })

  it('左侧放不下时放到下方，右边缘与行对齐', () => {
    expect(placeCommitPopover(row(100, 200, 460), POP, VP)).toEqual({ left: 460 - 420, top: 134, side: 'bottom' })
  })

  it('下方放不下时翻到上方', () => {
    expect(placeCommitPopover(row(600, 200, 460), POP, VP)).toEqual({ left: 40, top: 600 - 6 - 300, side: 'top' })
  })

  it('下方 / 上方时横向收进视口（行贴左边）', () => {
    const p = placeCommitPopover(row(100, 0, 260), POP, VP)
    expect(p.side).toBe('bottom')
    expect(p.left).toBe(8)
  })

  it('左 / 下 / 上都不够时放右侧', () => {
    const tall = { width: 300, height: 500 }
    const vp = { width: 1280, height: 700 }
    expect(placeCommitPopover({ left: 100, right: 400, top: 300, bottom: 328 }, tall, vp)).toEqual({ left: 406, top: 192, side: 'right' })
  })

  it('四面都放不下时选空间大的一侧并收进视口，坐标不为负', () => {
    const big = { width: 600, height: 500 }
    const vp = { width: 640, height: 600 }
    const p = placeCommitPopover({ left: 20, right: 620, top: 100, bottom: 128 }, big, vp)
    expect(p.side).toBe('bottom')
    expect(p.top).toBe(600 - 8 - 500)
    expect(p.left).toBe(20)
    const huge = placeCommitPopover({ left: 0, right: 300, top: 10, bottom: 38 }, { width: 900, height: 900 }, vp)
    expect(huge.left).toBe(8)
    expect(huge.top).toBe(8)
  })

  it('显式 prefer=left 与默认一致', () => {
    expect(placeCommitPopover(row(100), POP, VP, { prefer: 'left' })).toEqual(placeCommitPopover(row(100), POP, VP))
  })
})

describe('placeCommitPopover · prefer right（主区会话顶部标签）', () => {
  /** 主区左侧的历史列表：x 0..360，右边是详情区。 */
  const mainRow = (top: number, left = 0, right = 360) => ({ left, right, top, bottom: top + 28 })

  it('右侧放得下时放在行右侧，顶边与行对齐', () => {
    expect(placeCommitPopover(mainRow(100), POP, VP, { prefer: 'right' })).toEqual({ left: 366, top: 100, side: 'right' })
  })

  it('右侧时纵向收进视口', () => {
    const p = placeCommitPopover(mainRow(700), POP, VP, { prefer: 'right' })
    expect(p.side).toBe('right')
    expect(p.top).toBe(800 - 8 - 300)
  })

  it('右侧放不下时退回左侧', () => {
    expect(placeCommitPopover(mainRow(100, 500, 1000), POP, VP, { prefer: 'right' })).toEqual({ left: 500 - 6 - 420, top: 100, side: 'left' })
  })

  it('左右都放不下时放下方，左边缘与行左边缘对齐', () => {
    expect(placeCommitPopover(mainRow(100, 200, 1000), POP, VP, { prefer: 'right' })).toEqual({ left: 200, top: 134, side: 'bottom' })
  })

  it('下方也放不下时翻到上方', () => {
    expect(placeCommitPopover(mainRow(600, 300, 1270), POP, VP, { prefer: 'right' })).toEqual({ left: 300, top: 600 - 6 - 300, side: 'top' })
  })

  it('下方 / 上方时横向收进视口（行靠右、窗口窄）', () => {
    const p = placeCommitPopover(mainRow(100, 400, 630), POP, { width: 640, height: 800 }, { prefer: 'right' })
    expect(p).toEqual({ left: 640 - 8 - 420, top: 134, side: 'bottom' })
  })
})

describe('createHoverIntent', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = () => {
    const changes: Array<string | null> = []
    const h = createHoverIntent<string>((k) => changes.push(k))
    return { h, changes }
  }

  it('悬停 400ms 后显示，未满 400ms 移出则不显示', () => {
    const { h, changes } = setup()
    h.enter('a')
    vi.advanceTimersByTime(399)
    expect(h.current()).toBeNull()
    h.leave()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([])
    h.enter('a')
    vi.advanceTimersByTime(400)
    expect(changes).toEqual(['a'])
  })

  it('移出 150ms 后隐藏；期间移回同一行则保持', () => {
    const { h, changes } = setup()
    h.enter('a')
    vi.advanceTimersByTime(400)
    h.leave()
    vi.advanceTimersByTime(100)
    h.enter('a')
    vi.advanceTimersByTime(1000)
    expect(h.current()).toBe('a')
    h.leave()
    vi.advanceTimersByTime(149)
    expect(h.current()).toBe('a')
    vi.advanceTimersByTime(1)
    expect(h.current()).toBeNull()
    expect(changes).toEqual(['a', null])
  })

  it('移入浮窗保持显示，移出浮窗 150ms 后隐藏', () => {
    const { h } = setup()
    h.enter('a')
    vi.advanceTimersByTime(400)
    h.leave()
    vi.advanceTimersByTime(100)
    h.enterPopover()
    vi.advanceTimersByTime(5000)
    expect(h.current()).toBe('a')
    h.leavePopover()
    vi.advanceTimersByTime(150)
    expect(h.current()).toBeNull()
  })

  it('去浮窗途中路过另一行：不切换到那一行', () => {
    const { h, changes } = setup()
    h.enter('a')
    vi.advanceTimersByTime(400)
    h.leave()
    h.enter('b')
    vi.advanceTimersByTime(60)
    h.leave()
    h.enterPopover()
    vi.advanceTimersByTime(2000)
    expect(changes).toEqual(['a'])
  })

  it('在浮窗里时行失焦（如点了浮窗里的按钮）不隐藏', () => {
    const { h } = setup()
    h.enter('a')
    vi.advanceTimersByTime(400)
    h.enterPopover()
    h.leave()
    vi.advanceTimersByTime(2000)
    expect(h.current()).toBe('a')
  })

  it('同一时间只显示一个：停在另一行时旧的先收起、新的再出现', () => {
    const { h, changes } = setup()
    h.enter('a')
    vi.advanceTimersByTime(400)
    h.leave()
    h.enter('b')
    vi.advanceTimersByTime(150)
    expect(h.current()).toBeNull()
    vi.advanceTimersByTime(250)
    expect(changes).toEqual(['a', null, 'b'])
  })

  it('close 立即关闭并取消待显示', () => {
    const { h, changes } = setup()
    h.enter('a')
    vi.advanceTimersByTime(400)
    h.close()
    h.enter('b')
    h.close()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual(['a', null])
  })

  it('open 立即显示且固定：悬停进出不影响，close 后恢复悬停行为', () => {
    const { h } = setup()
    h.open('a')
    expect(h.current()).toBe('a')
    expect(h.pinned()).toBe(true)
    h.leave()
    h.leavePopover()
    h.enter('b')
    vi.advanceTimersByTime(2000)
    expect(h.current()).toBe('a')
    h.close()
    expect(h.pinned()).toBe(false)
    h.enter('b')
    vi.advanceTimersByTime(400)
    expect(h.current()).toBe('b')
  })

  it('dispose 清掉计时器', () => {
    const { h, changes } = setup()
    h.enter('a')
    h.dispose()
    vi.advanceTimersByTime(1000)
    expect(changes).toEqual([])
  })
})
