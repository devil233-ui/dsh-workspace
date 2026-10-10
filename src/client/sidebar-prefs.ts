/*
 * @Description: 浏览器端「侧边栏」偏好仓库 —— 从宿主取回、乐观更新、分发给各功能（标签注册、查看器、外观）
 * @Author: YangHeng
 * @Date: 2026-10-10 14:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar-prefs.ts
 *
 * 偏好本体落在宿主 prefs.json（字段与默认值见 wire/sidebar-prefs.ts），这里只是页内缓存：
 * - 读取方（register.tsx、appearance.ts、任务页 / 侧边对话 / 终端接管）用 getSidebarPrefs + subscribeSidebarPrefs，
 *   React 组件用 useSidebarPrefs；
 * - 取回之前用默认值（全部默认开启），所以宿主慢一点也不会出现「标签先消失再出现」；
 * - 查看器相关字段（文件关联、大文件阈值、HTML 沙箱）同步转成 viewers/prefs.ts 的覆盖值。
 */
import { useSyncExternalStore } from 'react'
import { DEFAULT_SIDEBAR_PREFS, mergeSidebarPrefs, normalizeSidebarPrefs, type SidebarPrefs, type SidebarPrefsPatch } from '../wire/sidebar-prefs.js'
import type { WorkspaceApi } from './api.js'
import { applyViewerPrefs, type ViewerPrefsOverrides } from './viewers/prefs.js'

export type { SidebarPrefs, SidebarPrefsPatch }

let current: SidebarPrefs = DEFAULT_SIDEBAR_PREFS
let loaded = false
const listeners = new Set<() => void>()

/** 侧边栏偏好 → 查看器覆盖值（纯函数，便于单测）。 */
export function viewerOverridesOf(p: SidebarPrefs): ViewerPrefsOverrides {
  return {
    ...(p.associations !== null ? { associations: p.associations, replaceAssociations: true } : {}),
    largeFileBytes: p.largeFileMB * 1024 * 1024,
    htmlSandbox: !p.htmlNoSandbox
  }
}

export function getSidebarPrefs(): SidebarPrefs {
  return current
}

/** 是否已从宿主取回过（取回前是默认值）。 */
export function sidebarPrefsLoaded(): boolean {
  return loaded
}

export function subscribeSidebarPrefs(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** 整体替换页内缓存并通知（宿主返回的结果、或乐观更新）。 */
export function setSidebarPrefs(next: unknown): void {
  const value = normalizeSidebarPrefs(next)
  if (JSON.stringify(value) === JSON.stringify(current)) return
  const viewerChanged = JSON.stringify(viewerOverridesOf(value)) !== JSON.stringify(viewerOverridesOf(current))
  current = value
  if (viewerChanged) applyViewerPrefs(viewerOverridesOf(value))
  // 逐个隔离：某个订阅方（如宿主注册表撤销时抛错）不能拦住其余订阅方，也不能让保存流程整体失败。
  for (const l of [...listeners]) {
    try {
      l()
    } catch (error) {
      console.warn('[dsh-workspace] 侧边栏偏好订阅回调出错', error)
    }
  }
}

/** 从宿主取回；失败保持当前值（默认值）并把错误抛给调用方决定是否提示。 */
export async function loadSidebarPrefs(api: WorkspaceApi): Promise<SidebarPrefs> {
  const out = await api.call('getPrefs', {})
  loaded = true
  setSidebarPrefs(out.sidebar)
  return current
}

let seq = 0
let chain: Promise<unknown> = Promise.resolve()

/**
 * 保存局部更新：先乐观更新页内缓存（开关即时生效），再串行写宿主。
 * 只有最后一次保存的结果回写缓存 —— 连续快速修改（如自定义 CSS 边打边存）时，旧请求的返回不会把新值冲掉。
 * 失败时从宿主重新取回真实值，并把错误抛给调用方提示。
 */
export function saveSidebarPrefs(api: WorkspaceApi, patch: SidebarPrefsPatch): Promise<SidebarPrefs> {
  setSidebarPrefs(mergeSidebarPrefs(current, patch))
  const mine = ++seq
  const run = chain.then(async () => {
    try {
      const out = await api.call('setSidebarPrefs', patch)
      loaded = true
      if (mine === seq) setSidebarPrefs(out.sidebar)
      return current
    } catch (error) {
      await loadSidebarPrefs(api).catch(() => undefined)
      throw error
    }
  })
  chain = run.catch(() => undefined)
  return run
}

/** React：订阅侧边栏偏好。 */
export function useSidebarPrefs(): SidebarPrefs {
  return useSyncExternalStore(subscribeSidebarPrefs, getSidebarPrefs, getSidebarPrefs)
}
