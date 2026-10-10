/*
 * @Description: 文件查看器偏好的读取入口（默认值 + 覆盖值）与 HTML 临时解锁状态
 * @Author: YangHeng
 * @Date: 2026-10-10 11:40:00
 * @FilePath: /dsh-workspace/src/client/viewers/prefs.ts
 *
 * 查看器只通过这里的函数读偏好；默认值写死在 defaults.ts。
 * 覆盖值来自「侧边栏」管理页（方案 3.1）：client/sidebar-prefs.ts 从宿主取回偏好后调用 applyViewerPrefs，
 * 已打开的查看器经 subscribeViewerPrefs 感知变化。
 */
import { DEFAULT_ASSOCIATIONS, DEFAULT_HTML_SANDBOX, DEFAULT_LARGE_FILE_BYTES, type ViewerAssociation } from './defaults.js'

export interface ViewerPrefs {
  /** 扩展名（小写、不带点）→ 查看器；与默认表合并，覆盖值优先。 */
  associations: Readonly<Record<string, ViewerAssociation>>
  /** 大文件阈值（字节）。 */
  largeFileBytes: number
  /** HTML 预览是否默认沙箱。 */
  htmlSandbox: boolean
}

export interface ViewerPrefsOverrides {
  associations?: Record<string, ViewerAssociation>
  /** true = associations 是完整表、整体替换默认表（管理页里删掉的默认扩展名才会真正失效）。 */
  replaceAssociations?: boolean
  largeFileBytes?: number
  htmlSandbox?: boolean
}

let overrides: ViewerPrefsOverrides = {}
let cached: ViewerPrefs | undefined
const listeners = new Set<() => void>()

/** 合并默认值与覆盖值（纯函数，便于单测）。 */
export function mergeViewerPrefs(o: ViewerPrefsOverrides): ViewerPrefs {
  const associations: Record<string, ViewerAssociation> = o.replaceAssociations === true && o.associations !== undefined ? {} : { ...DEFAULT_ASSOCIATIONS }
  for (const [ext, assoc] of Object.entries(o.associations ?? {})) associations[ext.replace(/^\./, '').toLowerCase()] = assoc
  const size = o.largeFileBytes
  return {
    associations,
    largeFileBytes: typeof size === 'number' && Number.isFinite(size) && size > 0 ? size : DEFAULT_LARGE_FILE_BYTES,
    htmlSandbox: typeof o.htmlSandbox === 'boolean' ? o.htmlSandbox : DEFAULT_HTML_SANDBOX
  }
}

export function getViewerPrefs(): ViewerPrefs {
  cached ??= mergeViewerPrefs(overrides)
  return cached
}

/** 写入覆盖值（整体替换）并通知订阅者。 */
export function applyViewerPrefs(next: ViewerPrefsOverrides): void {
  overrides = { ...next }
  cached = undefined
  for (const l of listeners) l()
}

export function subscribeViewerPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** 大文件阈值。 */
export function largeFileBytes(): number {
  return getViewerPrefs().largeFileBytes
}

/** 「默认不沙箱」偏好取反：true = HTML 预览默认放进沙箱。 */
export function htmlSandboxByDefault(): boolean {
  return getViewerPrefs().htmlSandbox
}

// ---------------------------------------------------------------- HTML 临时解锁（本次页面会话有效）

/**
 * 临时解锁的文件（键 = 主机 id + 路径）。放模块级而不是组件状态：切换标签、重新挂载后仍保持解锁；
 * 不落盘 —— 刷新页面即恢复沙箱，避免「一次解锁永久生效」。
 */
const unlocked = new Set<string>()

export function htmlUnlockKey(hostId: string, path: string): string {
  return `${hostId}\n${path}`
}

export function isHtmlUnlocked(key: string): boolean {
  return unlocked.has(key)
}

export function setHtmlUnlocked(key: string, value: boolean): void {
  if (value) unlocked.add(key)
  else unlocked.delete(key)
}
