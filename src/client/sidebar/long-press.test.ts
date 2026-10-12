import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLongPress } from './long-press.js'

describe('createLongPress', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  const setup = () => {
    const fired = vi.fn()
    const lp = createLongPress(fired)
    return { lp, fired }
  }

  it('按住 500ms 触发一次，未满 500ms 不触发', () => {
    const { lp, fired } = setup()
    lp.down(10, 10)
    expect(lp.pressing()).toBe(true)
    vi.advanceTimersByTime(499)
    expect(fired).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fired).toHaveBeenCalledTimes(1)
    expect(lp.pressing()).toBe(false)
    vi.advanceTimersByTime(2000)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('短按（500ms 内松开）不触发，随后的 click 不被吞', () => {
    const { lp, fired } = setup()
    lp.down(10, 10)
    vi.advanceTimersByTime(300)
    lp.up()
    vi.advanceTimersByTime(1000)
    expect(fired).not.toHaveBeenCalled()
    expect(lp.consumeClick()).toBe(false)
  })

  it('移动不超过 10px 仍触发；超过 10px 取消', () => {
    const { lp, fired } = setup()
    lp.down(100, 100)
    lp.move(106, 108)
    vi.advanceTimersByTime(500)
    expect(fired).toHaveBeenCalledTimes(1)

    lp.down(100, 100)
    vi.advanceTimersByTime(200)
    lp.move(100, 111)
    expect(lp.pressing()).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(fired).toHaveBeenCalledTimes(1)
  })

  it('滚动 / pointercancel（cancel）取消', () => {
    const { lp, fired } = setup()
    lp.down(0, 0)
    vi.advanceTimersByTime(400)
    lp.cancel()
    vi.advanceTimersByTime(1000)
    expect(fired).not.toHaveBeenCalled()
    expect(lp.consumeClick()).toBe(false)
  })

  it('触发后吞掉随后的一个 click，之后的 click 照常', () => {
    const { lp } = setup()
    lp.down(0, 0)
    vi.advanceTimersByTime(500)
    lp.up()
    expect(lp.consumeClick()).toBe(true)
    expect(lp.consumeClick()).toBe(false)
  })

  it('触发后浏览器没补 click：下一次按下复位，不误吞下一次短按', () => {
    const { lp } = setup()
    lp.down(0, 0)
    vi.advanceTimersByTime(500)
    lp.up()
    lp.down(0, 0)
    vi.advanceTimersByTime(100)
    lp.up()
    expect(lp.consumeClick()).toBe(false)
  })

  it('自定义延时与容差；dispose 清掉计时器', () => {
    const fired = vi.fn()
    const lp = createLongPress(fired, { delay: 300, tolerance: 4 })
    lp.down(0, 0)
    lp.move(5, 0)
    vi.advanceTimersByTime(300)
    expect(fired).not.toHaveBeenCalled()
    lp.down(0, 0)
    vi.advanceTimersByTime(300)
    expect(fired).toHaveBeenCalledTimes(1)
    lp.down(0, 0)
    lp.dispose()
    vi.advanceTimersByTime(1000)
    expect(fired).toHaveBeenCalledTimes(1)
  })
})
