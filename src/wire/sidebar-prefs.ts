/*
 * @Description: 「侧边栏」管理页的偏好模型（宿主与浏览器共享）—— 字段、默认值、规范化与合并
 * @Author: YangHeng
 * @Date: 2026-10-10 14:00:00
 * @FilePath: /dsh-workspace/src/wire/sidebar-prefs.ts
 *
 * 为什么放在 wire/ 并落在宿主 prefs.json：Agent 工具 open_in_sidebar（方案 3.6）在宿主端注册，
 * 它的开关必须宿主可读；浏览器端经 getPrefs 取回后由 client/sidebar-prefs.ts 分发给各功能。
 * 本文件会进浏览器 bundle：不得 import zod 或任何 node: 模块。
 */
import { normalizeOpenWith, type OpenWithTemplate } from './open-with.js'

export type { OpenWithTemplate }

/** 可开关的侧栏标签（sidechat = 侧边对话）。 */
export const SIDEBAR_TAB_KEYS = ['files', 'git', 'viewer', 'ssh', 'tasks', 'sidechat'] as const
export type SidebarTabKey = (typeof SIDEBAR_TAB_KEYS)[number]
/**
 * 已下线的标签开关键（dock = 底部 dock，用户决定取消）。为什么还要列出来：
 * 老版本写进 prefs.json 的键由 normalizeSidebarPrefs 自然丢弃；但升级后仍开着的旧页面可能还会提交 { tabs: { dock } }，
 * 局部更新的 zod 是严格模式，不认识的键会整单拒绝 —— 这里登记的键被接受后由规范化丢弃，不影响同一次提交里的其他字段。
 */
export const RETIRED_SIDEBAR_TAB_KEYS = ['dock'] as const

/** 文件关联可选的查看器（与 client/viewers/defaults.ts 的 ViewerKind 一致）。 */
export const ASSOC_VIEWERS = ['monaco', 'markdown', 'html', 'image', 'media', 'file-viewer', 'download'] as const
export type AssocViewer = (typeof ASSOC_VIEWERS)[number]
export const ASSOC_MODES = ['preview', 'edit'] as const
export type AssocMode = (typeof ASSOC_MODES)[number]

export interface AssocEntry {
  viewer: AssocViewer
  mode?: AssocMode
}

export interface SidebarPrefs {
  /** 标签开关（默认全开）。 */
  tabs: Record<SidebarTabKey, boolean>
  /**
   * 文件关联（扩展名小写、不带点 → 查看器）。null = 使用内置默认表；
   * 非 null = 用户编辑过的完整表（整体替换默认表，这样「删除某个默认扩展名」才能生效）。
   */
  associations: Record<string, AssocEntry> | null
  /** 大文件阈值（MB）。 */
  largeFileMB: number
  /** HTML 预览默认不沙箱（默认关 = 默认沙箱）。 */
  htmlNoSandbox: boolean
  /** Agent 工具 open_in_sidebar（默认开）。 */
  openInSidebar: boolean
  /** 新子代理 / 后台任务自动打开任务页（默认开；窄屏不自动开由使用方判断）。 */
  tasksAutoOpen: boolean
  /** IME 守卫：输入法组字期间的按键不冒泡给宿主快捷键（默认开）。 */
  imeGuard: boolean
  /** 自定义 CSS（注入 <style data-dshws-custom>）。 */
  customCss: string
  /** 文件树自动刷新：展开着的目录有增删改名时自动重载（默认开）。 */
  autoRefresh: boolean
  /** 「打开方式」里的自定义 URL 模板（变量 {path} {host} {user} {port}）。 */
  openWith: OpenWithTemplate[]
  /**
   * 远程工作区使用插件 SSH 终端（默认开）：远程会话里右侧栏引导页的「新建终端」改开本插件的 SSH 终端；
   * 本机会话始终是宿主终端。关闭后完全回到宿主行为。
   */
  remoteSshTerminal: boolean
  /**
   * 侧边对话的分叉来源记录（父会话 → 子会话，方案 3.8）。宿主会话列表虽然也有 parentId，
   * 但 DSH 自带的「从这里分叉」也会产生同样的父子关系 —— 只有这里记下的才是「侧边对话」。
   */
  sidechats: SidechatRecord[]
}

/** 一条侧边对话记录。 */
export interface SidechatRecord {
  parentId: string
  childId: string
  /** 创建时间（毫秒）。 */
  createdAt: number
}

/** 侧边对话记录上限：超出时丢最旧的（偏好文件不无限增长）。 */
export const SIDECHATS_MAX = 200
/** 会话 id 的长度上限（与网关其他 sessionId 校验一致）。 */
export const SESSION_ID_MAX = 256

/** 局部更新：只传要改的字段；tabs 也可只传部分。 */
export type SidebarPrefsPatch = Partial<Omit<SidebarPrefs, 'tabs'>> & { tabs?: Partial<Record<SidebarTabKey, boolean>> }

export const LARGE_FILE_MB_MIN = 1
export const LARGE_FILE_MB_MAX = 4096
export const CUSTOM_CSS_MAX = 64 * 1024
export const ASSOC_MAX = 500

export const DEFAULT_SIDEBAR_PREFS: SidebarPrefs = Object.freeze({
  tabs: Object.freeze({ files: true, git: true, viewer: true, ssh: true, tasks: true, sidechat: true }),
  associations: null,
  largeFileMB: 20,
  htmlNoSandbox: false,
  openInSidebar: true,
  tasksAutoOpen: true,
  imeGuard: true,
  customCss: '',
  autoRefresh: true,
  openWith: Object.freeze([]) as unknown as OpenWithTemplate[],
  remoteSshTerminal: true,
  sidechats: Object.freeze([]) as unknown as SidechatRecord[]
}) as SidebarPrefs

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const bool = (v: unknown, fallback: boolean): boolean => (typeof v === 'boolean' ? v : fallback)

/** 扩展名规范化：去前导点、转小写；不合法（含路径分隔符、空白等）返回 undefined。 */
export function normalizeExt(raw: string): string | undefined {
  const ext = raw.trim().replace(/^\.+/, '').toLowerCase()
  return /^[a-z0-9][a-z0-9_+-]{0,31}$/.test(ext) ? ext : undefined
}

function normalizeAssociations(raw: unknown): Record<string, AssocEntry> | null {
  if (!isObject(raw)) return null
  const out: Record<string, AssocEntry> = {}
  for (const [key, value] of Object.entries(raw).slice(0, ASSOC_MAX)) {
    const ext = normalizeExt(key)
    if (ext === undefined || !isObject(value)) continue
    const viewer = value.viewer
    if (typeof viewer !== 'string' || !(ASSOC_VIEWERS as readonly string[]).includes(viewer)) continue
    const mode = value.mode
    out[ext] = typeof mode === 'string' && (ASSOC_MODES as readonly string[]).includes(mode)
      ? { viewer: viewer as AssocViewer, mode: mode as AssocMode }
      : { viewer: viewer as AssocViewer }
  }
  return out
}

/**
 * 从任意输入（偏好文件里读出的 JSON、旧版本缺字段）得到完整偏好：缺失 / 非法字段一律回默认值，
 * 偏好文件被手改坏也不影响插件运行。
 */
export function normalizeSidebarPrefs(raw: unknown): SidebarPrefs {
  const d = DEFAULT_SIDEBAR_PREFS
  const o = isObject(raw) ? raw : {}
  const tabsIn = isObject(o.tabs) ? o.tabs : {}
  const tabs = Object.fromEntries(SIDEBAR_TAB_KEYS.map((k) => [k, bool(tabsIn[k], d.tabs[k])])) as Record<SidebarTabKey, boolean>
  const mb = o.largeFileMB
  return {
    tabs,
    associations: normalizeAssociations(o.associations),
    largeFileMB: typeof mb === 'number' && Number.isFinite(mb) ? Math.min(LARGE_FILE_MB_MAX, Math.max(LARGE_FILE_MB_MIN, Math.round(mb))) : d.largeFileMB,
    htmlNoSandbox: bool(o.htmlNoSandbox, d.htmlNoSandbox),
    openInSidebar: bool(o.openInSidebar, d.openInSidebar),
    tasksAutoOpen: bool(o.tasksAutoOpen, d.tasksAutoOpen),
    imeGuard: bool(o.imeGuard, d.imeGuard),
    customCss: typeof o.customCss === 'string' ? o.customCss.slice(0, CUSTOM_CSS_MAX) : d.customCss,
    autoRefresh: bool(o.autoRefresh, d.autoRefresh),
    openWith: normalizeOpenWith(o.openWith),
    remoteSshTerminal: bool(o.remoteSshTerminal, d.remoteSshTerminal),
    sidechats: normalizeSidechats(o.sidechats)
  }
}

const sessionIdOk = (v: unknown): v is string => typeof v === 'string' && v !== '' && v.length <= SESSION_ID_MAX

/**
 * 侧边对话记录规范化：丢非法项、同一子会话只留最新一条、按创建时间升序、超出上限丢最旧的。
 * 子会话等于父会话的记录没有意义（也会让线程列表把自己列进去），一并丢掉。
 */
export function normalizeSidechats(raw: unknown): SidechatRecord[] {
  if (!Array.isArray(raw)) return []
  const byChild = new Map<string, SidechatRecord>()
  for (const item of raw) {
    if (!isObject(item)) continue
    const { parentId, childId, createdAt } = item
    if (!sessionIdOk(parentId) || !sessionIdOk(childId) || parentId === childId) continue
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt) || createdAt < 0) continue
    const prev = byChild.get(childId)
    if (prev === undefined || prev.createdAt <= createdAt) byChild.set(childId, { parentId, childId, createdAt: Math.round(createdAt) })
  }
  const list = [...byChild.values()].sort((a, b) => a.createdAt - b.createdAt)
  return list.length > SIDECHATS_MAX ? list.slice(list.length - SIDECHATS_MAX) : list
}

/** 追加一条侧边对话记录（同一子会话覆盖旧记录）。 */
export function addSidechat(list: readonly SidechatRecord[], record: SidechatRecord): SidechatRecord[] {
  return normalizeSidechats([...list.filter((r) => r.childId !== record.childId), record])
}

/** 移除一条侧边对话记录。 */
export function removeSidechat(list: readonly SidechatRecord[], childId: string): SidechatRecord[] {
  return list.filter((r) => r.childId !== childId)
}

/**
 * 某父会话的侧边对话线程（新的在前）。exists 用来过滤掉已删除的会话：
 * 返回 undefined 表示「还不知道」（会话列表未加载完），此时保留记录，避免列表闪烁成空。
 */
export function sidechatThreads(list: readonly SidechatRecord[], parentId: string, exists: (id: string) => boolean | undefined): SidechatRecord[] {
  return list.filter((r) => r.parentId === parentId && exists(r.childId) !== false).sort((a, b) => b.createdAt - a.createdAt)
}

/** 把局部更新合并进当前偏好（结果再规范化一次）。associations 显式传 null = 恢复默认表。 */
export function mergeSidebarPrefs(current: SidebarPrefs, patch: SidebarPrefsPatch): SidebarPrefs {
  return normalizeSidebarPrefs({
    ...current,
    ...patch,
    tabs: { ...current.tabs, ...(patch.tabs ?? {}) }
  })
}
