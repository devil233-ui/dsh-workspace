import { describe, expect, it } from 'vitest'
import { nearestScrollLeft, wheelToHorizontal } from './tabstrip.js'

describe('nearestScrollLeft', () => {
  it('已可见不动；左侧被遮贴左；右侧被遮贴右；比可视区宽贴左', () => {
    expect(nearestScrollLeft(50, 200, 80, 60)).toBe(50)
    expect(nearestScrollLeft(100, 200, 40, 60)).toBe(40)
    expect(nearestScrollLeft(0, 200, 180, 60)).toBe(40)
    expect(nearestScrollLeft(10, 50, 30, 80)).toBe(30)
  })
})

describe('wheelToHorizontal', () => {
  it('放得下时不接管', () => {
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 100 }, 200, 200)).toBeNull()
  })
  it('纵向滚轮转为横向位移', () => {
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 120 }, 400, 200)).toBe(120)
    expect(wheelToHorizontal({ deltaX: 2, deltaY: -60 }, 400, 200)).toBe(-60)
  })
  it('触控板横滑、Shift / Ctrl 滚轮交给浏览器', () => {
    expect(wheelToHorizontal({ deltaX: 40, deltaY: 10 }, 400, 200)).toBeNull()
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 100, shiftKey: true }, 400, 200)).toBeNull()
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 100, ctrlKey: true }, 400, 200)).toBeNull()
    expect(wheelToHorizontal({ deltaX: 0, deltaY: 0 }, 400, 200)).toBeNull()
  })
})
