/*
 * @Description: dsh-better-sidebar（BS）状态检测与禁用 / 启用 —— 经宿主 pluginManager
 * @Author: YangHeng
 * @Date: 2026-10-10 14:00:00
 * @FilePath: /dsh-workspace/src/better-sidebar.ts
 *
 * 宿主 pluginManager（dsh-plugin-manager）：
 * - listPlugins()：每行 { entryId, moduleName, enabled, patchId? , readOnlyReason? }；带 readOnlyReason 的行不能经 profile 补丁修改
 * - setPluginEnabled(entryId, enabled)：写 profile 补丁并热重载，返回 { application: applied|restart-required|overridden|failed, error? }
 * 改动对整个 profile 生效（所有窗口、所有会话），且宿主不做二次确认 —— 所以只在用户点击触发的网关方法里调用，
 * 界面先弹确认框；不在插件启动 / HMR 事务里调用（那时改插件启用状态会和宿主的重载事务互相嵌套）。
 */

/** pluginManager 里本模块用到的部分（均为可选：旧宿主可能没有）。 */
export interface PluginRowLike {
  entryId: string
  moduleName?: string
  enabled?: boolean
  patchId?: string
  readOnlyReason?: string
}

export interface PluginToggleResult {
  application?: string
  error?: { code?: string; diagnostic?: string }
}

export interface PluginManagerToggleLike {
  listPlugins?(): Promise<PluginRowLike[]> | PluginRowLike[]
  setPluginEnabled?(entryId: string, enabled: boolean): Promise<PluginToggleResult> | PluginToggleResult
}

export interface BetterSidebarStatus {
  /** 宿主 pluginManager 可用（不可用时界面引导去宿主插件页手动处理）。 */
  available: boolean
  installed: boolean
  enabled: boolean
  entryId?: string
  /** 宿主拒绝经 profile 补丁修改的原因（management-required / unaddressable 等）。 */
  readOnlyReason?: string
}

export type BetterSidebarApplication = 'applied' | 'restart-required' | 'overridden' | 'failed' | 'cancelled'

export interface BetterSidebarToggleOutput {
  application: BetterSidebarApplication
  /** application = failed 时的可读原因。 */
  error?: string
  /** 操作后的状态（重新读取）。 */
  status: BetterSidebarStatus
}

export const BS_PATCH_ID = 'better-sidebar'
export const BS_MODULE = 'dsh-better-sidebar'

export class BetterSidebarError extends Error {}

/** 按补丁 id 或模块名定位 BS 的那一行（模块名兼容带 scope 的写法）。 */
export function findBetterSidebar(rows: readonly PluginRowLike[]): PluginRowLike | undefined {
  return rows.find(
    (r) => r.patchId === BS_PATCH_ID || r.moduleName === BS_MODULE || (typeof r.moduleName === 'string' && r.moduleName.endsWith(`/${BS_MODULE}`))
  )
}

function usable(pm: PluginManagerToggleLike | undefined): pm is Required<PluginManagerToggleLike> {
  return pm !== undefined && typeof pm.listPlugins === 'function' && typeof pm.setPluginEnabled === 'function'
}

export async function betterSidebarStatus(pm: PluginManagerToggleLike | undefined): Promise<BetterSidebarStatus> {
  if (!usable(pm)) return { available: false, installed: false, enabled: false }
  const rows = await pm.listPlugins()
  const row = findBetterSidebar(Array.isArray(rows) ? rows : [])
  if (row === undefined) return { available: true, installed: false, enabled: false }
  return {
    available: true,
    installed: true,
    enabled: row.enabled !== false,
    entryId: row.entryId,
    ...(row.readOnlyReason !== undefined ? { readOnlyReason: row.readOnlyReason } : {})
  }
}

const APPLICATIONS: readonly string[] = ['applied', 'restart-required', 'overridden', 'failed', 'cancelled']

/**
 * 禁用 / 启用 BS。entryId 每次重新从 listPlugins 取（不信任浏览器传来的 id）。
 * @throws BetterSidebarError pluginManager 不可用、未安装或该行只读
 */
export async function betterSidebarSetEnabled(pm: PluginManagerToggleLike | undefined, enabled: boolean): Promise<BetterSidebarToggleOutput> {
  if (!usable(pm)) throw new BetterSidebarError('宿主插件管理器（pluginManager）不可用，请到宿主「插件」页手动处理 dsh-better-sidebar。')
  const before = await betterSidebarStatus(pm)
  if (!before.installed || before.entryId === undefined) throw new BetterSidebarError('未安装 dsh-better-sidebar。')
  if (before.readOnlyReason !== undefined) {
    throw new BetterSidebarError(`宿主不允许在此修改 dsh-better-sidebar（${before.readOnlyReason}），请到宿主「插件」页手动处理。`)
  }
  const result = await pm.setPluginEnabled(before.entryId, enabled)
  const raw = typeof result?.application === 'string' ? result.application : 'failed'
  const application = (APPLICATIONS.includes(raw) ? raw : 'failed') as BetterSidebarApplication
  const error = application === 'failed' ? [result?.error?.code, result?.error?.diagnostic].filter((s) => typeof s === 'string' && s !== '').join(': ') || '未知错误' : undefined
  // 重新读一次：overridden（被更高优先级配置覆盖）时实际状态与请求不同，界面以它为准。
  const status = await betterSidebarStatus(pm).catch(() => before)
  return { application, ...(error !== undefined ? { error } : {}), status }
}
