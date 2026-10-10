/*
 * @Description: Agent 工具 open_in_sidebar 的共享契约（宿主与浏览器共用）—— 工具名、返回值、结果文本的生成与解析
 * @Author: YangHeng
 * @Date: 2026-10-10 16:00:00
 * @FilePath: /dsh-workspace/src/wire/open-in-sidebar.ts
 *
 * 为什么结果文本里带一行 JSON：浏览器端的 tool.call.toolview 只拿得到工具结果的渲染文本（block.content），
 * 拿不到结构化返回值。真正的「打开」在浏览器执行（宿主没有宿主 → 浏览器的推送通道），
 * 所以把 {kind,target,remoteHost} 以带标记的一行 JSON 附在文本末尾，两端用同一份函数生成 / 解析，格式不会漂移。
 * 本文件会进浏览器 bundle：不得 import zod 或任何 node: 模块。
 */

/** 本插件的工具名。 */
export const OPEN_TOOL_NAME = 'open_in_sidebar'
/** dsh-better-sidebar 的同类工具名：本插件在 Agent 作用域里遮蔽它（见 agent/register.ts）。 */
export const BS_OPEN_TOOL_NAME = 'sidebar_open'

export type OpenKind = 'file' | 'folder' | 'url'

/** 工具返回值（与 BS sidebar_open 一致，另加 remoteHost）。 */
export interface OpenValue {
  kind: OpenKind
  /** 本机绝对路径 / 远程绝对路径（POSIX）/ http(s) 地址。 */
  target: string
  title: string
  /** 请求已交给会话界面（由当前显示该会话的页面在侧栏执行；宿主无法确认页面是否在显示）。 */
  delivered: boolean
  /** 远程工作区里的目标：主机 id。本机路径与网址没有此字段。 */
  remoteHost?: string
}

/** 结果文本中 JSON 行的前缀标记。 */
export const OPEN_RESULT_MARKER = 'dsh-workspace:open '

const KINDS: readonly string[] = ['file', 'folder', 'url']

/** 生成模型可读 + 浏览器可解析的结果文本。 */
export function formatOpenResult(value: OpenValue): string {
  const where = value.remoteHost !== undefined ? ' on the remote host' : ''
  const line = `Opened ${value.kind} "${value.title}" (${value.target}${where}) in the sidebar. It appears only if this conversation is currently displayed in a page; otherwise the user can reopen it from the tool card.`
  return `${line}\n${OPEN_RESULT_MARKER}${JSON.stringify(value)}`
}

/** 从结果文本解析返回值；不是本插件生成的（如 BS 的结果）返回 undefined。 */
export function parseOpenResult(text: string): OpenValue | undefined {
  const at = text.lastIndexOf(OPEN_RESULT_MARKER)
  if (at === -1) return undefined
  const end = text.indexOf('\n', at)
  try {
    const raw = JSON.parse(text.slice(at + OPEN_RESULT_MARKER.length, end === -1 ? undefined : end)) as Record<string, unknown>
    if (typeof raw.kind !== 'string' || !KINDS.includes(raw.kind) || typeof raw.target !== 'string' || raw.target === '') return undefined
    return {
      kind: raw.kind as OpenKind,
      target: raw.target,
      title: typeof raw.title === 'string' ? raw.title : raw.target,
      delivered: raw.delivered === true,
      ...(typeof raw.remoteHost === 'string' && raw.remoteHost !== '' ? { remoteHost: raw.remoteHost } : {})
    }
  } catch {
    return undefined
  }
}

/** 是否 Windows 盘符前缀（C:\ / C:/）：它是路径，不是 URL 协议。 */
export function isWindowsDrivePrefix(raw: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(raw)
}

/** 是否 http(s) 网址。 */
export function isHttpUrl(raw: string): boolean {
  return /^https?:\/\//i.test(raw)
}

/** 是否带了别的协议（file: / javascript: / vscode: …）；盘符不算。 */
export function hasOtherScheme(raw: string): boolean {
  return !isWindowsDrivePrefix(raw) && !isHttpUrl(raw) && /^[a-z][a-z0-9+.-]*:/i.test(raw)
}
