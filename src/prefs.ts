/*
 * @Description: 插件偏好设置（忽略规则、接管「添加工作区」、接管「文件」侧栏、「侧边栏」管理页、远程会话保留本机 shell）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/prefs.ts
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { renameWithRetry } from './fs-atomic.js'
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { pluginRoot } from './paths.js'
import { DEFAULT_SIDEBAR_PREFS, mergeSidebarPrefs, normalizeSidebarPrefs, type SidebarPrefs, type SidebarPrefsPatch } from './wire/sidebar-prefs.js'

export interface Prefs {
  /** 用户追加的忽略规则（.gitignore 写法），叠加在内置默认规则之后。 */
  ignore: string[]
  /**
   * 接管「添加工作区」（侧栏按钮 / 首页 / 快捷键），弹出本插件的本地 + 远程弹窗。
   * 默认开启；关闭后恢复 DSH 原来的选择器（刷新页面生效）。
   */
  takeoverAddWorkspace: boolean
  /**
   * 接管 DSH 自带的「文件」侧栏（kind files），换成本插件的「文件管理」。默认开启；
   * 其他插件（如 better-sidebar）已接管时不抢，只提示。
   */
  takeoverFilesSidebar: boolean
  /**
   * 接管远程工作区时是否保留本机 shell（pwsh / powershell / cmd）。默认关闭：
   * 这些工具从清单里去掉，避免模型在**本机**执行命令；打开后照常可用，
   * 但命令确实跑在本机（设置页有警示、连接日志留痕）。切换后刷新页面 / 重开会话生效。
   */
  allowLocalShell: boolean
  /** 「侧边栏」管理页的偏好（标签开关、文件关联、外观等，见 wire/sidebar-prefs.ts）。 */
  sidebar: SidebarPrefs
}

const DEFAULTS: Prefs = { ignore: [], takeoverAddWorkspace: true, takeoverFilesSidebar: true, allowLocalShell: false, sidebar: DEFAULT_SIDEBAR_PREFS }

export function prefsFile(): string {
  return path.join(pluginRoot(), 'prefs.json')
}

export class PrefsStore {
  private data: Prefs | undefined
  private listeners = new Set<(prefs: Prefs) => void>()

  /** 偏好保存后通知（宿主端功能按偏好即时注册 / 撤销，如 open_in_sidebar）。返回取消订阅。 */
  subscribe(listener: (prefs: Prefs) => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get(): Prefs {
    if (this.data !== undefined) return this.data
    const file = prefsFile()
    if (!existsSync(file)) return (this.data = { ...DEFAULTS })
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Partial<Prefs>
      this.data = {
        ignore: Array.isArray(parsed.ignore) ? parsed.ignore.filter((s): s is string => typeof s === 'string') : [],
        takeoverAddWorkspace: parsed.takeoverAddWorkspace !== false,
        takeoverFilesSidebar: parsed.takeoverFilesSidebar !== false,
        allowLocalShell: parsed.allowLocalShell === true,
        sidebar: normalizeSidebarPrefs(parsed.sidebar)
      }
    } catch {
      // 偏好文件损坏不应影响主功能：退回默认值（下次保存会覆盖修复）。
      this.data = { ...DEFAULTS }
    }
    return this.data
  }

  setIgnore(rules: string[]): Prefs {
    const cleaned = rules.map((r) => r.trim()).filter((r) => r !== '')
    return this.save({ ...this.get(), ignore: cleaned })
  }

  setTakeover(enabled: boolean): Prefs {
    return this.save({ ...this.get(), takeoverAddWorkspace: enabled })
  }

  setFilesTakeover(enabled: boolean): Prefs {
    return this.save({ ...this.get(), takeoverFilesSidebar: enabled })
  }

  /** 远程工作区会话是否保留本机 shell（默认关闭；打开后命令会在本机执行）。 */
  setLocalShell(enabled: boolean): Prefs {
    return this.save({ ...this.get(), allowLocalShell: enabled })
  }

  setSidebar(patch: SidebarPrefsPatch): Prefs {
    const current = this.get()
    return this.save({ ...current, sidebar: mergeSidebarPrefs(current.sidebar, patch) })
  }

  private save(next: Prefs): Prefs {
    const file = prefsFile()
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
    const tmp = `${file}.${randomUUID().slice(0, 8)}.tmp`
    writeFileSync(tmp, JSON.stringify(next, null, 2), { encoding: 'utf8', mode: 0o600 })
    renameWithRetry(tmp, file)
    this.data = next
    // 监听方出错不能影响保存结果（偏好已落盘）。
    for (const listener of [...this.listeners]) {
      try {
        listener(next)
      } catch {
        /* 忽略 */
      }
    }
    return next
  }
}
