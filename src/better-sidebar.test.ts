/*
 * @Description: dsh-better-sidebar 状态检测与禁用 / 启用的测试（mock pluginManager）
 * @Author: YangHeng
 * @Date: 2026-10-10 14:00:00
 * @FilePath: /dsh-workspace/src/better-sidebar.test.ts
 */
import { describe, expect, it, vi } from 'vitest'
import { BetterSidebarError, betterSidebarSetEnabled, betterSidebarStatus, findBetterSidebar, type PluginRowLike } from './better-sidebar.js'

/** 模拟宿主 pluginManager：setPluginEnabled 改写行状态，返回 application。 */
function fakePm(rows: PluginRowLike[], application = 'applied', error?: { code?: string; diagnostic?: string }) {
  const setPluginEnabled = vi.fn(async (entryId: string, enabled: boolean) => {
    const row = rows.find((r) => r.entryId === entryId)
    if (row !== undefined && application !== 'overridden' && application !== 'failed') row.enabled = enabled
    return { application, ...(error !== undefined ? { error } : {}) }
  })
  return { listPlugins: vi.fn(async () => rows), setPluginEnabled }
}

const other: PluginRowLike = { entryId: 'x1', moduleName: 'dsh-skill-mcp-panel', enabled: true, patchId: 'mcp' }

describe('findBetterSidebar', () => {
  it('按 patchId 或模块名定位（含带 scope 的模块名）', () => {
    expect(findBetterSidebar([other, { entryId: 'a', patchId: 'better-sidebar', moduleName: 'whatever' }])?.entryId).toBe('a')
    expect(findBetterSidebar([{ entryId: 'b', moduleName: 'dsh-better-sidebar', readOnlyReason: 'unaddressable' }])?.entryId).toBe('b')
    expect(findBetterSidebar([{ entryId: 'c', moduleName: '@someone/dsh-better-sidebar' }])?.entryId).toBe('c')
    expect(findBetterSidebar([other])).toBeUndefined()
  })
})

describe('betterSidebarStatus', () => {
  it('pluginManager 不可用（缺席或缺方法）→ available=false', async () => {
    expect(await betterSidebarStatus(undefined)).toEqual({ available: false, installed: false, enabled: false })
    expect((await betterSidebarStatus({ listPlugins: async () => [] })).available).toBe(false)
  })

  it('未安装 / 已启用 / 已禁用 / 只读', async () => {
    expect(await betterSidebarStatus(fakePm([other]))).toEqual({ available: true, installed: false, enabled: false })
    expect(await betterSidebarStatus(fakePm([other, { entryId: 'bs', moduleName: 'dsh-better-sidebar', enabled: true, patchId: 'better-sidebar' }]))).toEqual({
      available: true,
      installed: true,
      enabled: true,
      entryId: 'bs'
    })
    const off = await betterSidebarStatus(fakePm([{ entryId: 'bs', moduleName: 'dsh-better-sidebar', enabled: false, patchId: 'better-sidebar' }]))
    expect(off.enabled).toBe(false)
    const ro = await betterSidebarStatus(fakePm([{ entryId: 'bs', moduleName: 'dsh-better-sidebar', enabled: true, readOnlyReason: 'unaddressable' }]))
    expect(ro.readOnlyReason).toBe('unaddressable')
  })
})

describe('betterSidebarSetEnabled', () => {
  it('禁用：用 listPlugins 返回的 entryId 调 setPluginEnabled，返回 application 与新状态', async () => {
    const pm = fakePm([other, { entryId: 'bs', moduleName: 'dsh-better-sidebar', enabled: true, patchId: 'better-sidebar' }])
    const out = await betterSidebarSetEnabled(pm, false)
    expect(pm.setPluginEnabled).toHaveBeenCalledWith('bs', false)
    expect(out.application).toBe('applied')
    expect(out.status.enabled).toBe(false)
    expect(out.error).toBeUndefined()
    // 重新启用
    const back = await betterSidebarSetEnabled(pm, true)
    expect(pm.setPluginEnabled).toHaveBeenLastCalledWith('bs', true)
    expect(back.status.enabled).toBe(true)
  })

  it('restart-required / overridden 原样透出；failed 带可读错误', async () => {
    const row = (): PluginRowLike[] => [{ entryId: 'bs', moduleName: 'dsh-better-sidebar', enabled: true, patchId: 'better-sidebar' }]
    expect((await betterSidebarSetEnabled(fakePm(row(), 'restart-required'), false)).application).toBe('restart-required')
    const over = await betterSidebarSetEnabled(fakePm(row(), 'overridden'), false)
    expect(over.application).toBe('overridden')
    expect(over.status.enabled).toBe(true)
    const failed = await betterSidebarSetEnabled(fakePm(row(), 'failed', { code: 'operation-error', diagnostic: 'boom' }), false)
    expect(failed.application).toBe('failed')
    expect(failed.error).toBe('operation-error: boom')
    // 未知 application 归为 failed
    expect((await betterSidebarSetEnabled(fakePm(row(), 'weird'), false)).application).toBe('failed')
  })

  it('不可用 / 未安装 / 只读：抛 BetterSidebarError，不调用 setPluginEnabled', async () => {
    await expect(betterSidebarSetEnabled(undefined, false)).rejects.toBeInstanceOf(BetterSidebarError)
    const none = fakePm([other])
    await expect(betterSidebarSetEnabled(none, false)).rejects.toThrow(/未安装/)
    const ro = fakePm([{ entryId: 'bs', moduleName: 'dsh-better-sidebar', enabled: true, readOnlyReason: 'management-required' }])
    await expect(betterSidebarSetEnabled(ro, false)).rejects.toThrow(/management-required/)
    expect(none.setPluginEnabled).not.toHaveBeenCalled()
    expect(ro.setPluginEnabled).not.toHaveBeenCalled()
  })
})
