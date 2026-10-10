/*
 * @Description: 宿主能力桥测试 —— open-in-app 探测必须按 cordis 服务名直取，且永不同步抛错
 * @Author: YangHeng
 * @Date: 2026-10-10 15:10:00
 * @FilePath: /dsh-workspace/src/client/sidebar/host-bridge.test.ts
 *
 * 回归：0.12.3-dev 里经 ctx.get('remote').session 取会话远程接口，cordis 追踪代理同步抛
 * 「cannot get property "remote.session" without inject」；它发生在文件树的 useEffect 里，
 * 宿主插槽错误边界吞掉后「文件管理」「Git 仓库」整个标签空白（本机会话）。
 */
import { afterEach, describe, expect, it } from 'vitest'
import { openInApp, openInAppAvailable, setSidebarHost } from './host-bridge.js'

/** 模拟 cordis：remote 服务的 .session 属性访问在未 inject 时同步抛错，ctx.get('remote.session') 正常。 */
function cordisLike(session: unknown) {
  const remote = {
    get session(): never {
      throw new Error('cannot get property "remote.session" without inject')
    }
  }
  return { get: (name: string) => (name === 'remote' ? remote : name === 'remote.session' ? session : undefined) }
}

afterEach(() => setSidebarHost(undefined))

describe('openInAppAvailable', () => {
  it('按服务名 remote.session 直取，不经 remote 的属性访问（后者在宿主里会抛错）', async () => {
    const calls: unknown[] = []
    setSidebarHost(
      cordisLike({
        canOpenWorkspacePath: async () => ({ ok: true, value: true }),
        openWorkspacePath: async (req: unknown) => (calls.push(req), { ok: true })
      })
    )
    await expect(openInAppAvailable()).resolves.toBe(true)
    await expect(openInApp('C:\\a.txt', true)).resolves.toBe(true)
    expect(calls).toEqual([{ path: 'C:\\a.txt', action: 'reveal' }])
  })

  it('宿主接口缺失 / ctx.get 抛错 / 探测同步抛错：都只降级为不可用，绝不同步抛出', async () => {
    setSidebarHost(cordisLike(undefined))
    await expect(openInAppAvailable()).resolves.toBe(false)
    setSidebarHost({
      get: () => {
        throw new Error('boom')
      }
    })
    expect(() => openInAppAvailable()).not.toThrow()
    await expect(openInAppAvailable()).resolves.toBe(false)
    setSidebarHost(
      cordisLike({
        canOpenWorkspacePath: () => {
          throw new Error('sync')
        },
        openWorkspacePath: async () => ({ ok: true })
      })
    )
    expect(() => openInAppAvailable()).not.toThrow()
    await expect(openInAppAvailable()).resolves.toBe(false)
  })
})
