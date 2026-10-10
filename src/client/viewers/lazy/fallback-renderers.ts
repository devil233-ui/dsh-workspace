/*
 * @Description: file-viewer 兜底渲染器 —— 支持矩阵里本项目不装配的类别统一给出「不支持在线预览」提示，文本类给轻量纯文本预览
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/client/viewers/lazy/fallback-renderers.ts
 *
 * 为什么需要：rendererMode: 'replace' 下，凡是 core 支持矩阵里有、但没装配 renderer 的扩展名，
 * file-viewer 会显示「xx 格式已在支持矩阵中，但当前项目尚未装配 xx renderer」并附带 npm 安装指引 —— 这是给集成方看的，
 * 不该让最终用户看到。顶层分派（dispatch.ts 的白名单）已经挡住了大部分入口，但压缩包内预览
 * （renderer-archive 用同一份 renderers 建嵌套 registry）和用户自定义关联仍会走到这里，所以在 file-viewer 内部再兜一层。
 * 定义直接复用 core 的 DEFAULT_RENDERER_DEFINITIONS（扩展名、类别与 core 保持一致，升级时自动跟随），只替换 handler。
 */
import { DEFAULT_RENDERER_DEFINITIONS, resolveFileViewerLocale } from '@file-viewer/core'
import type { FileRenderContext, FileRenderHandler, FileViewerRendererPlugin, RendererDefinition } from '@file-viewer/core'

/** 走纯文本兜底的 core 类别：压缩包里的源码 / 配置 / Markdown 很常见，直接看原文比「请下载」有用得多。 */
export const TEXT_FALLBACK_RENDERER_IDS: ReadonlySet<string> = new Set(['code', 'markdown'])

/** 纯文本兜底最多解码的字节数：整段塞进 <pre> 没有虚拟滚动，太大会卡住页面。 */
export const TEXT_FALLBACK_MAX_BYTES = 2 * 1024 * 1024

interface FallbackMessages { unsupported: string, truncated: string }

const MESSAGES: Record<'zh-CN' | 'en-US', FallbackMessages> = {
  'zh-CN': {
    unsupported: '该格式不支持在线预览，请下载后用系统应用打开',
    truncated: '（文件较大，仅显示前 {size} MB）'
  },
  'en-US': {
    unsupported: 'This format cannot be previewed online. Please download it and open it with a system app.',
    truncated: '(Large file: showing the first {size} MB only)'
  }
}

/** 跟随 file-viewer 自身的语言判定（locale 选项 / 浏览器语言），让兜底文案与查看器工具栏语言一致；非中文一律英文。 */
function messages(context: FileRenderContext | undefined): FallbackMessages {
  return resolveFileViewerLocale(context?.options as never) === 'zh-CN' ? MESSAGES['zh-CN'] : MESSAGES['en-US']
}

/** 与 core 内置 renderUnsupported 相同的返回形状：内容挂在 target 上，卸载由宿主清空容器。 */
function rendered(target: HTMLElement): { $el: HTMLElement, unmount(): void } {
  return { $el: target, unmount() {} }
}

/** 一行居中提示：不支持在线预览。 */
export const renderUnsupportedNotice: FileRenderHandler = async (_buffer, target, _type, context) => {
  const doc = target.ownerDocument
  const line = doc.createElement('div')
  line.setAttribute('data-dshws-fallback', 'unsupported')
  line.style.cssText = 'padding:48px 16px;text-align:center;font-size:13px;opacity:.75'
  line.textContent = messages(context).unsupported
  target.replaceChildren(line)
  return rendered(target)
}

/** 粗判二进制：前 8KB 出现 NUL 字节基本不是文本（UTF-16 文本也会命中，按不支持处理即可）。 */
function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8192)
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true
  return false
}

/** 纯文本预览：TextDecoder 解码（容错，不抛异常）放进 <pre>，超过上限只显示开头并注明。 */
export const renderPlainText: FileRenderHandler = async (buffer, target, type, context) => {
  const bytes = new Uint8Array(buffer, 0, Math.min(buffer.byteLength, TEXT_FALLBACK_MAX_BYTES))
  if (looksBinary(bytes)) return renderUnsupportedNotice(buffer, target, type, context)
  const doc = target.ownerDocument
  const wrap = doc.createElement('div')
  wrap.setAttribute('data-dshws-fallback', 'text')
  wrap.style.cssText = 'height:100%;overflow:auto;box-sizing:border-box'
  if (buffer.byteLength > TEXT_FALLBACK_MAX_BYTES) {
    const note = doc.createElement('div')
    note.style.cssText = 'padding:6px 12px;font-size:12px;opacity:.7'
    note.textContent = messages(context).truncated.replace('{size}', String(TEXT_FALLBACK_MAX_BYTES / 1024 / 1024))
    wrap.appendChild(note)
  }
  const pre = doc.createElement('pre')
  pre.style.cssText = 'margin:0;padding:12px;white-space:pre-wrap;word-break:break-all;font:12px/1.6 ui-monospace,SFMono-Regular,Consolas,monospace'
  // textContent 赋值不会解析 HTML，压缩包里的 .html / .svg 原文也只是文本，不会执行。
  pre.textContent = new TextDecoder('utf-8').decode(bytes)
  wrap.appendChild(pre)
  target.replaceChildren(wrap)
  return rendered(target)
}

/** 只关心已装配 renderer 的定义（各 renderer 的 handler 泛型不同，这里不必约束）。 */
type InstalledRenderer = Pick<FileViewerRendererPlugin<unknown>, 'definitions'>

/** 已装配的 renderer 覆盖了哪些 core 类别 id。 */
function installedIds(installed: readonly InstalledRenderer[]): Set<string> {
  const ids = new Set<string>()
  for (const p of installed) for (const d of p.definitions ?? []) ids.add(d.id)
  return ids
}

/**
 * 为 core 矩阵中所有「未装配」的类别生成兜底 renderer：文本类别走纯文本，其余一行提示。
 * definitions 参数只为测试注入，运行时用 core 的默认格式表。
 */
export function fallbackRenderers(
  installed: readonly InstalledRenderer[],
  definitions: readonly RendererDefinition[] = DEFAULT_RENDERER_DEFINITIONS
): FileViewerRendererPlugin[] {
  const have = installedIds(installed)
  const missing = definitions.filter((d) => !have.has(d.id))
  if (missing.length === 0) return []
  return [
    {
      id: 'dshws-fallback',
      definitions: missing,
      handlers: missing.map((d) => ({
        rendererId: d.id,
        handler: TEXT_FALLBACK_RENDERER_IDS.has(d.id) ? renderPlainText : renderUnsupportedNotice
      }))
    }
  ]
}
