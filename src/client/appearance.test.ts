/*
 * @Description: 外观偏好测试 —— IME 守卫只拦组字按键（不 preventDefault、可撤销、放行终端 / 编辑器），随偏好开关
 * @Author: YangHeng
 * @Date: 2026-10-10 14:00:00
 * @FilePath: /dsh-workspace/src/client/appearance.test.ts
 */
import { afterEach, describe, expect, it } from 'vitest'
import { installImeGuard, isImeKey } from './appearance.js'
import { getSidebarPrefs, setSidebarPrefs } from './sidebar-prefs.js'
import { DEFAULT_SIDEBAR_PREFS, mergeSidebarPrefs } from '../wire/sidebar-prefs.js'

/** 构造一个两层的事件路径：root（守卫挂这里，捕获阶段）→ child（目标，记录是否收到）。 */
function setup(closest?: (selector: string) => unknown) {
  const root = new EventTarget()
  let received = 0
  const child = new EventTarget()
  child.addEventListener('keydown', () => received++)
  // Node 的 EventTarget 没有 DOM 树：守卫挂在 root 上，派发时手动模拟「捕获 → 目标」两步。
  const dispatch = (init: { isComposing?: boolean; keyCode?: number }, type = 'keydown') => {
    const e = new Event(type, { cancelable: true })
    Object.assign(e, init)
    Object.defineProperty(e, 'target', { value: { closest } })
    let stopped = false
    const orig = e.stopPropagation.bind(e)
    e.stopPropagation = () => {
      stopped = true
      orig()
    }
    root.dispatchEvent(e)
    if (!stopped) child.dispatchEvent(new Event(type))
    return { stopped, prevented: e.defaultPrevented }
  }
  return { root, dispatch, received: () => received }
}

afterEach(() => setSidebarPrefs(DEFAULT_SIDEBAR_PREFS))

describe('IME 守卫', () => {
  it('isImeKey：isComposing 或 keyCode 229', () => {
    expect(isImeKey({ isComposing: true })).toBe(true)
    expect(isImeKey({ keyCode: 229 })).toBe(true)
    expect(isImeKey({ keyCode: 13 })).toBe(false)
  })

  it('组字按键停止传播但不 preventDefault；普通按键照常；撤销后不再拦截', () => {
    const s = setup()
    const off = installImeGuard(s.root)
    expect(s.dispatch({ isComposing: true, keyCode: 13 })).toEqual({ stopped: true, prevented: false })
    expect(s.dispatch({ keyCode: 229 }, 'keyup').stopped).toBe(true)
    expect(s.dispatch({ keyCode: 13 }).stopped).toBe(false)
    expect(s.received()).toBe(1)
    off()
    expect(s.dispatch({ isComposing: true }).stopped).toBe(false)
  })

  it('终端 / 代码编辑器内的组字按键放行（它们自己处理输入法）', () => {
    const s = setup((sel) => (sel.includes('.xterm') ? {} : null))
    const off = installImeGuard(s.root)
    expect(s.dispatch({ keyCode: 229 }).stopped).toBe(false)
    off()
  })

  it('偏好开关：页内缓存更新即时可读', () => {
    setSidebarPrefs(mergeSidebarPrefs(DEFAULT_SIDEBAR_PREFS, { imeGuard: false, customCss: 'a{}' }))
    expect(getSidebarPrefs().imeGuard).toBe(false)
    expect(getSidebarPrefs().customCss).toBe('a{}')
  })
})
