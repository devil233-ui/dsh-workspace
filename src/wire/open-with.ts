/*
 * @Description: 文件树「打开方式」—— 内置编辑器 URL（VS Code / Cursor / Zed）、自定义 URL 模板展开、协议白名单（宿主与浏览器共享）
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/wire/open-with.ts
 *
 * 本文件会进浏览器 bundle：不得 import zod 或任何 node: 模块。
 * 宿主端 openExternalUrl 用 isAllowedExternalUrl 再校验一次（不信任浏览器）：只放行内置编辑器协议、http(s)
 * 与用户在「侧边栏」页里保存过的模板所用的协议；file: / javascript: / ms-* 这类可被利用的协议一律拒绝。
 */

/** 一次批量查询目录修改时间的上限（展开的目录 + 根）。 */
export const DIR_STAMPS_MAX = 200
/** 外部 URL / 模板长度上限。 */
export const OPEN_URL_MAX = 2000
/** 自定义模板条数上限、名称长度上限。 */
export const OPEN_WITH_MAX = 20
export const OPEN_WITH_NAME_MAX = 40

export interface OpenWithTemplate {
  name: string
  template: string
}

/** 打开的目标：本机文件用原生路径（正斜杠，如 C:/x/a.ts、/home/a）；远程文件用远程绝对路径并带主机信息。 */
export interface OpenTarget {
  path: string
  remote: boolean
  host?: string
  user?: string
  port?: number
}

/** 内置编辑器的协议（宿主无条件放行）。 */
export const BUILTIN_SCHEMES = ['vscode', 'vscode-insiders', 'cursor', 'zed', 'windsurf', 'http', 'https'] as const

/** 无论如何都不放行的协议：可直接读写本机文件、执行脚本，或历史上被用于远程代码执行的 Windows 协议。 */
const DENIED_SCHEME = /^(file|javascript|data|vbscript|blob|about|jar|ms-[\w.+-]*|search-ms|search|shell|mk|res|its|hcp)$/i

/** URL 的协议（小写，不含冒号）；不像 URL 返回 undefined。 */
export function schemeOf(url: string): string | undefined {
  const m = /^([A-Za-z][A-Za-z0-9+.-]{0,31}):/.exec(url.trim())
  return m === null ? undefined : (m[1] as string).toLowerCase()
}

/** 路径编码：逐段百分号编码，保留 / 与盘符冒号（URL 里路径分隔符必须原样）。 */
export function encodePathForUrl(p: string): string {
  return p
    .split('/')
    .map((seg, i) => (i <= 1 && /^[A-Za-z]:$/.test(seg) ? seg : encodeURIComponent(seg)))
    .join('/')
}

/**
 * 展开自定义模板：{path} {host} {user} {port}。
 * path 逐段编码（保留 /），其余整体编码；本机文件 host 为 localhost、user / port 为空。
 */
export function expandTemplate(template: string, target: OpenTarget): string {
  const vars: Record<string, string> = {
    path: encodePathForUrl(target.path),
    host: encodeURIComponent(target.host ?? (target.remote ? '' : 'localhost')),
    user: encodeURIComponent(target.user ?? ''),
    port: target.port !== undefined ? String(target.port) : ''
  }
  return template.replace(/\{(path|host|user|port)\}/g, (_, k: string) => vars[k] as string)
}

/** VS Code 系 URL 的「主机部分」：user@host（端口非 22 时 Remote-SSH 需要在 ssh 配置里定义别名，这里不拼端口）。 */
function sshAuthority(t: OpenTarget): string {
  const host = t.host ?? ''
  return t.user !== undefined && t.user !== '' ? `${t.user}@${host}` : host
}

/** 本机路径在 URL 里的写法：C:/x → /C:/x（URL 路径以 / 开头），/home/x 原样。 */
function urlPath(p: string): string {
  const s = p.replace(/\\/g, '/')
  return encodePathForUrl(s.startsWith('/') ? s : `/${s}`)
}

/** 内置「打开方式」：VS Code / Cursor / Zed（远程文件走各自的 SSH 远程协议）。 */
export function builtinOpeners(t: OpenTarget): Array<{ id: string; label: string; url: string }> {
  if (!t.remote) {
    const p = urlPath(t.path)
    return [
      { id: 'vscode', label: 'VS Code', url: `vscode://file${p}` },
      { id: 'cursor', label: 'Cursor', url: `cursor://file${p}` },
      { id: 'zed', label: 'Zed', url: `zed://file${p}` }
    ]
  }
  if (t.host === undefined || t.host === '') return []
  const authority = encodeURIComponent(sshAuthority(t)).replace(/%40/g, '@')
  const p = encodePathForUrl(t.path)
  const zedHost = `${authority}${t.port !== undefined && t.port !== 22 ? `:${t.port}` : ''}`
  return [
    { id: 'vscode', label: 'VS Code', url: `vscode://vscode-remote/ssh-remote+${authority}${p}` },
    { id: 'cursor', label: 'Cursor', url: `cursor://vscode-remote/ssh-remote+${authority}${p}` },
    { id: 'zed', label: 'Zed', url: `zed://ssh/${zedHost}${p}` }
  ]
}

/** 模板是否可保存：必须以协议开头，且不是禁用协议。返回错误说明或 undefined。 */
export function templateProblem(template: string): string | undefined {
  const s = schemeOf(template)
  if (s === undefined) return 'missing-scheme'
  if (DENIED_SCHEME.test(s)) return 'denied-scheme'
  if (template.length > OPEN_URL_MAX || /[\u0000-\u001f]/.test(template)) return 'invalid'
  return undefined
}

/** 规范化模板列表（偏好文件里读出、或浏览器提交的）：丢弃非法项、去重、截断到上限。 */
export function normalizeOpenWith(raw: unknown): OpenWithTemplate[] {
  if (!Array.isArray(raw)) return []
  const out: OpenWithTemplate[] = []
  for (const item of raw) {
    if (out.length >= OPEN_WITH_MAX) break
    if (typeof item !== 'object' || item === null) continue
    const name = typeof (item as { name?: unknown }).name === 'string' ? ((item as { name: string }).name.trim().slice(0, OPEN_WITH_NAME_MAX)) : ''
    const template = typeof (item as { template?: unknown }).template === 'string' ? (item as { template: string }).template.trim() : ''
    if (name === '' || templateProblem(template) !== undefined) continue
    out.push({ name, template })
  }
  return out
}

/** 宿主端校验：协议在白名单（内置 + 用户模板所用协议）里、且不是禁用协议、无控制字符。 */
export function isAllowedExternalUrl(url: string, templates: readonly OpenWithTemplate[]): boolean {
  if (url.length > OPEN_URL_MAX || /[\u0000-\u001f\s]/.test(url)) return false
  const s = schemeOf(url)
  if (s === undefined || DENIED_SCHEME.test(s)) return false
  if ((BUILTIN_SCHEMES as readonly string[]).includes(s)) return true
  return templates.some((t) => schemeOf(t.template) === s)
}
