/*
 * @Description: 提交说明正文 → 安全的 HTML（Git「历史」页签的提交说明浮窗用，见 CommitPopover.tsx）
 * @Author: YangHeng
 * @Date: 2026-10-10 17:20:00
 * @FilePath: /dsh-workspace/src/client/sidebar/commit-message.ts
 *
 * 为什么不像文件预览那样放进无脚本 iframe：提交说明浮窗是一小块内联内容，iframe 要额外量高度、跟主题，
 * 代价远大于收益。这里改为在生成阶段就把危险的东西去掉，结果可以直接 innerHTML：
 * 1. 原始 HTML（块级 / 行内）一律转义成文本 —— 提交说明里的 <script>、<img onerror> 只会原样显示；
 * 2. 链接只放行 http(s) / mailto，其余（javascript:、data: 等）降级为纯文本；放行的链接新窗口打开且不带 opener；
 * 3. 图片不加载（避免跟踪像素 / 内网探测），降级为指向原地址的链接；
 * 4. 最后再过一遍 stripActiveTags（与 Markdown 预览同一套纵深防御）。
 * marked 自身对文本、属性值都会做 HTML 转义，所以剩下的标签只可能是 marked 生成的白名单结构。
 */
import { Marked, type Tokens } from 'marked'
import { stripActiveTags } from './markdown.js'

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')

/** 只放行 http(s) / mailto；marked 传进来的 href 可能已被百分号编码，先解码再判断协议，防止 java&#115;cript: 一类绕过。 */
export function safeHref(href: string): string | null {
  let raw = href.trim()
  try {
    raw = decodeURIComponent(raw)
  } catch {
    // 非法编码：按原样判断。
  }
  // 去掉控制字符与空白后再看协议：浏览器解析 URL 时会忽略这些字符（"java\tscript:" 也能执行）。
  const compact = raw.replace(/[\u0000-\u0020\u007f]+/g, '').toLowerCase()
  if (/^(https?:|mailto:)/.test(compact)) return href.trim()
  return null
}

type InlineParser = { parser: { parseInline(tokens: Tokens.Generic[]): string } }

const md = new Marked({ gfm: true, breaks: true, async: false })
md.use({
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag): string {
      return escapeHtml(token.text)
    },
    link(this: InlineParser, token: Tokens.Link): string {
      const inner = this.parser.parseInline(token.tokens)
      const href = safeHref(token.href)
      if (href === null) return inner
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : ''
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer">${inner}</a>`
    },
    image(token: Tokens.Image): string {
      const label = escapeHtml(token.text || token.href)
      const href = safeHref(token.href)
      return href === null ? label : `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${label}</a>`
    }
  }
})

/** 提交正文 Markdown → 可直接 innerHTML 的安全 HTML。breaks: true —— 提交说明习惯按行写，单个换行也要保留。 */
export function renderCommitBody(body: string): string {
  if (body.trim() === '') return ''
  return stripActiveTags(md.parse(body) as string)
}
