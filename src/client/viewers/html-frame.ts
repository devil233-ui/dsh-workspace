/*
 * @Description: HTML 预览 iframe 的渲染决策与探针状态（纯函数，便于单测）
 * @Author: YangHeng
 * @Date: 2026-10-12 18:00:00
 * @FilePath: /dsh-workspace/src/client/viewers/html-frame.ts
 */
import { hasOwnCsp, probeInsertAt, type ProbeMessage } from '../../wire/preview-probe.js'

/**
 * 沙箱：脚本可运行，但没有 allow-same-origin（不透明源，碰不到 DSH 界面与接口）。
 * allow-modals：不给的话 alert / confirm / prompt 被浏览器静默忽略，演示页「什么都没发生」；
 * 弹窗只能阻塞预览页自己的事件循环，拿不到 DSH 的任何数据，风险只是可能被连续弹窗打扰（关预览即止）。
 */
export const HTML_SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals'

/** 预览怎么加载：src = iframe 直接指向预览路由；srcdoc = 内联资源后写进 srcdoc。 */
export type FrameLoad = 'src' | 'srcdoc'

/**
 * 选择加载方式。
 * 为什么优先 src：srcdoc 文档的基址是父页面地址，脚本运行时的相对地址（new Worker('worker.js')、fetch、
 * 动态 import、未内联的资源）都会解析到 DSH 页面根目录下；iframe 直接加载预览路由时，文档基址就是文件所在目录。
 * - 页面不是 http(s)（dsh-app:// / file:）：iframe 用 http 地址会跨协议，退回 srcdoc（另注入 <base>，见 withBaseHref）。
 * - 桌面版 + 沙箱：桌面版只给「来源与 DSH 页面相同」的帧请求附渲染进程令牌，沙箱页是不透明源 null，
 *   在「允许浏览器访问」关闭时预览路由的主文档与样式脚本请求都会被拒（整页空白），所以仍走 srcdoc 内联。
 * - 其余（网页版，或桌面版解除沙箱 = 与 DSH 同源，请求带令牌）：走 src。
 */
export function frameLoadMode(input: { protocol: string; desktop: boolean; sandboxed: boolean }): FrameLoad {
  if (input.protocol !== 'http:' && input.protocol !== 'https:') return 'srcdoc'
  if (input.desktop && input.sandboxed) return 'srcdoc'
  return 'src'
}

/**
 * srcdoc 模式下 <base href> 指向预览路由里文件所在目录（尽力而为：让运行时相对地址至少指向正确的文件）。
 * file: 等页面上预览路由不可达，返回 undefined（保持现状）。
 * @param url 预览路由地址（可为相对地址）
 * @param pageHref 当前页面地址（location.href）
 */
export function previewBaseHref(url: string, pageHref: string): string | undefined {
  let page: URL
  try {
    page = new URL(pageHref)
  } catch {
    return undefined
  }
  if (/^(?:file|about|data|blob):$/.test(page.protocol)) return undefined
  return new URL('./', new URL(url, page)).href
}

/** 注入 <base href>（插在 <head> 之后，先于页面里任何相对地址）；页面自带 <base> 时尊重页面。 */
export function withBaseHref(html: string, href: string): string {
  if (/<base\b/i.test(html)) return html
  const at = probeInsertAt(html)
  return `${html.slice(0, at)}<base href="${href.replace(/"/g, '&quot;')}">${html.slice(at)}`
}

/** 探针等待上限：超过仍没收到 load 回报，提示用户去看 DevTools。 */
export const PROBE_TIMEOUT_MS = 10_000

export interface FramePlan {
  key: string
  src?: string
  srcDoc?: string
  sandbox?: string
}

/**
 * 预览 iframe 怎么渲染：有预览路由地址走 src，否则走 srcdoc。
 * 键里同时带 nonce（保存 / 刷新）与沙箱状态 —— sandbox 属性只在 iframe 导航时生效，
 * 解除 / 恢复沙箱必须换一个新的浏览上下文，否则旧页面仍按原来的沙箱运行。
 */
export function framePlan(input: { src: string | null | undefined; srcDoc: string | null; sandboxed: boolean; nonce: number }): FramePlan | undefined {
  const sandbox = input.sandboxed ? { sandbox: HTML_SANDBOX } : {}
  if (typeof input.src === 'string') return { key: `src|${input.src}|${input.nonce}|${input.sandboxed}`, src: input.src, ...sandbox }
  if (input.srcDoc !== null) return { key: `doc|${input.nonce}|${input.sandboxed}`, srcDoc: input.srcDoc, ...sandbox }
  return undefined
}

/** 只给 .html / .htm 注入探针（svg / xhtml 按 XML 解析，插脚本会破坏文档）；页面自带 CSP 时也不注入。 */
export function shouldProbe(path: string, content: string | null): boolean {
  if (!/\.html?$/i.test(path)) return false
  return content === null || !hasOwnCsp(content)
}

/** 预览路由地址加上 probe=1（只有主文档带，相对资源请求不带）。 */
export function withProbeQuery(url: string): string {
  return `${url}${url.includes('?') ? '&' : '?'}probe=1`
}

/** 一次加载里探针回报的累计状态。 */
export interface ProbeState {
  loaded: boolean
  /** 页面 load 后 body 里既没有文字也没有可见元素（script / style 等不算）。 */
  empty: boolean
  /** 页面有自己的 <script>（不含探针）。 */
  scripted: boolean
  errors: string[]
  resources: string[]
}

export const EMPTY_PROBE: ProbeState = { loaded: false, empty: false, scripted: false, errors: [], resources: [] }

/** 合并一条探针消息（同类消息去重、各最多留 5 条）。 */
export function reduceProbe(state: ProbeState, msg: ProbeMessage): ProbeState {
  const push = (list: string[], v: string) => (list.includes(v) || list.length >= 5 ? list : [...list, v])
  if (msg.kind === 'load') return { ...state, loaded: true, empty: msg.text === 0 && msg.elements === 0, scripted: msg.scripts > 0 }
  if (msg.kind === 'error') return { ...state, errors: push(state.errors, msg.message) }
  return { ...state, resources: push(state.resources, msg.src) }
}

/**
 * 报错是否像「沙箱拿走了同源能力」：不透明源 null 下 Worker / 存储 / cookie 都会被拒。
 * 命中时提示用户可临时解除沙箱，而不是让人以为页面本身坏了。
 */
export function looksLikeSandboxDenial(message: string): boolean {
  // module script：沙箱页从不透明源导入同目录模块属于跨源请求，预览路由不发 CORS 头（不让不可信页面读工作区文件），必然失败。
  return /SecurityError|origin 'null'|\bWorker\b|module script|sandbox|localStorage|sessionStorage|indexedDB|cookie/i.test(message)
}

/** 提示条（查看器按顺序渲染）。 */
export interface ProbeNote {
  tone: 'error' | 'warn' | 'info'
  key: string
  vars?: Record<string, string>
  /** 追加在正文后的提示（文案键）。 */
  hint?: string
  title?: string
}

/**
 * 把探针状态归成要显示的提示（纯函数，文案分类在这里定，便于单测）。
 * 「没有可见内容」分两种：页面有自己的脚本时多半是演示页（alert / console 输出），只做中性说明，不报成故障。
 */
export function probeNotes(probe: ProbeState, opts: { sandboxed: boolean; timedOut: boolean; timeoutSeconds: number }): ProbeNote[] {
  const notes: ProbeNote[] = []
  if (probe.errors.length > 0) {
    const hint = opts.sandboxed && probe.errors.some(looksLikeSandboxDenial) ? 'viewer.htmlSandboxHint' : undefined
    notes.push({ tone: 'error', key: 'viewer.htmlError', vars: { message: probe.errors[0] as string }, title: probe.errors.join('\n'), ...(hint !== undefined ? { hint } : {}) })
  } else if (probe.loaded && probe.empty) {
    notes.push(probe.scripted ? { tone: 'info', key: 'viewer.htmlEmptyScripted' } : { tone: 'warn', key: 'viewer.htmlEmpty' })
  }
  if (opts.timedOut && !probe.loaded) notes.push({ tone: 'warn', key: 'viewer.htmlNoSignal', vars: { seconds: String(opts.timeoutSeconds) } })
  return notes
}
