/*
 * @Description: 浏览器端侧边栏偏好仓库 —— 订阅回调相互隔离
 * @Author: YangHeng
 * @Date: 2026-10-10 21:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar-prefs.test.ts
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getSidebarPrefs, setSidebarPrefs, subscribeSidebarPrefs } from './sidebar-prefs.js'
import { DEFAULT_SIDEBAR_PREFS } from '../wire/sidebar-prefs.js'

describe('sidebar-prefs', () => {
  afterEach(() => setSidebarPrefs(DEFAULT_SIDEBAR_PREFS))

  it('某个订阅方抛错不影响其余订阅方，也不让 setSidebarPrefs 抛出', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const offA = subscribeSidebarPrefs(() => {
      throw new Error('boom')
    })
    let seen = 0
    const offB = subscribeSidebarPrefs(() => {
      seen += 1
    })
    expect(() => setSidebarPrefs({ ...DEFAULT_SIDEBAR_PREFS, tabs: { ...DEFAULT_SIDEBAR_PREFS.tabs, git: false } })).not.toThrow()
    expect(seen).toBe(1)
    expect(getSidebarPrefs().tabs.git).toBe(false)
    offA()
    offB()
    warn.mockRestore()
  })
})
