/*
 * @Description: Markdown → 预览页面（放进无脚本沙箱 iframe 的 srcdoc）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/markdown.ts
 *
 * 安全：Markdown 里可以夹带任意 HTML。这里不做白名单清洗，而是让 iframe 本身不可执行脚本
 * （sandbox 不含 allow-scripts）+ CSP 禁止脚本 —— 页面最多只能显示，发不出脚本请求。
 * 增强预览（viewers/MarkdownView）给 iframe 加了 allow-same-origin（仍然没有 allow-scripts）：父文档要读选区、
 * 处理目录跳转与图表放大；没有脚本能力时同源标志只对父文档有用，页面自身依旧什么都执行不了。
 * 另外 stripActiveTags 去掉 meta / base / 嵌套框架 / 表单等「无脚本也能起作用」的标签，作为纵深防御。
 * 相对图片（./img/a.png）经 <base> 指向远程预览路由，与 HTML 预览同一套令牌鉴权。
 */
import { marked } from 'marked'

const escapeAttr = (s: string): string => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')

/**
 * @param markdown Markdown 原文
 * @param baseHref 该文件所在目录的预览地址（绝对 URL，以 / 结尾）；undefined 时相对图片不加载
 * @param dark 是否深色主题
 */
export function markdownDocument(markdown: string, baseHref: string | undefined, dark: boolean): string {
  const body = marked.parse(markdown, { gfm: true, breaks: false, async: false }) as string
  return markdownPage(body, baseHref, dark)
}

/**
 * 去掉不需要脚本也能产生副作用的标签：meta（refresh 跳转）、base（改写相对地址）、嵌套框架 / 插件、表单、外链样式。
 * iframe 本身已禁脚本，这里只是纵深防御；正文里的普通 HTML（表格、details、图片）保留。
 */
export function stripActiveTags(html: string): string {
  return html
    .replace(/<(script|iframe|frame|frameset|object|embed|applet|noscript)\b[\s\S]*?<\/\1\s*>/gi, '')
    // input 保留：GFM 任务列表的勾选框就是 <input type="checkbox" disabled>。
    .replace(/<\/?(?:script|meta|base|link|iframe|frame|frameset|object|embed|applet|form|portal)\b[^>]*>/gi, '')
}

/** 正文 HTML → 完整页面（样式 + CSP + 可选 <base>）。 */
export function markdownPage(bodyHtml: string, baseHref: string | undefined, dark: boolean): string {
  const imgSrc = baseHref === undefined ? 'data:' : `${new URL(baseHref).origin} data:`
  const fg = dark ? '#d4d4d4' : '#1f2328'
  const bg = dark ? '#1e1e1e' : '#ffffff'
  const border = dark ? '#3a3a3a' : '#d0d7de'
  const codeBg = dark ? '#2a2a2a' : '#f6f8fa'
  const link = dark ? '#4ea1ff' : '#0969da'
  const muted = dark ? '#9da5b4' : '#59636e'
  return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${imgSrc} https: blob:; style-src 'unsafe-inline'; font-src data:">
${baseHref === undefined ? '' : `<base href="${escapeAttr(baseHref)}">`}
<style>
  body { margin: 0; padding: 16px 20px 40px; color: ${fg}; background: ${bg};
    font: 14px/1.65 -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif; word-wrap: break-word; }
  h1, h2 { border-bottom: 1px solid ${border}; padding-bottom: .3em; }
  h1, h2, h3, h4 { margin: 1.2em 0 .6em; line-height: 1.3; scroll-margin-top: 8px; }
  a { color: ${link}; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 85%; background: ${codeBg}; padding: .15em .35em; border-radius: 4px; }
  pre { background: ${codeBg}; padding: 12px 14px; border-radius: 6px; overflow: auto; }
  pre code { background: none; padding: 0; font-size: 12.5px; }
  blockquote { margin: 0; padding: 0 1em; color: ${muted}; border-left: 4px solid ${border}; }
  table { border-collapse: collapse; display: block; overflow: auto; }
  th, td { border: 1px solid ${border}; padding: 6px 12px; }
  img { max-width: 100%; }
  hr { border: 0; border-top: 1px solid ${border}; }
  ul.contains-task-list { padding-left: 1.2em; }
  .dshws-front-matter { margin: 0 0 16px; border: 1px solid ${border}; border-radius: 6px; padding: 6px 10px; font-size: 12.5px; }
  .dshws-front-matter summary { cursor: pointer; color: ${muted}; }
  .dshws-front-matter table { display: table; margin-top: 6px; }
  .dshws-front-matter th { text-align: left; color: ${muted}; font-weight: 500; }
  .dshws-front-matter pre { margin: 6px 0 0; }
  .dshws-mermaid { margin: 12px 0; text-align: center; cursor: zoom-in; overflow: auto; }
  .dshws-mermaid svg { max-width: 100%; height: auto; }
  .dshws-mermaid-error { color: #d1242f; font-size: 12px; text-align: left; }
  .dshws-math[data-display="1"] { overflow-x: auto; margin: 12px 0; text-align: center; }
  math[display="block"] { margin: 0 auto; }
  .hljs-comment, .hljs-quote { color: ${dark ? '#8b949e' : '#6e7781'}; font-style: italic; }
  .hljs-keyword, .hljs-selector-tag, .hljs-literal, .hljs-doctag, .hljs-meta .hljs-keyword { color: ${dark ? '#ff7b72' : '#cf222e'}; }
  .hljs-string, .hljs-regexp, .hljs-addition, .hljs-meta .hljs-string { color: ${dark ? '#a5d6ff' : '#0a3069'}; }
  .hljs-number, .hljs-symbol, .hljs-bullet, .hljs-variable.constant_, .hljs-attr, .hljs-attribute { color: ${dark ? '#79c0ff' : '#0550ae'}; }
  .hljs-title, .hljs-title.function_, .hljs-section { color: ${dark ? '#d2a8ff' : '#8250df'}; }
  .hljs-title.class_, .hljs-type, .hljs-built_in, .hljs-name, .hljs-selector-id, .hljs-selector-class { color: ${dark ? '#ffa657' : '#953800'}; }
  .hljs-deletion { color: ${dark ? '#ffdcd7' : '#82071e'}; background: ${dark ? '#67060c' : '#ffebe9'}; }
  .hljs-addition { background: ${dark ? '#033a16' : '#dafbe1'}; }
  .hljs-meta, .hljs-tag { color: ${dark ? '#7ee787' : '#116329'}; }
  .hljs-emphasis { font-style: italic; } .hljs-strong { font-weight: 600; }
</style></head><body>${bodyHtml}</body></html>`
}

/** 预览地址所在的目录（绝对 URL）：给 <base> 用。 */
export function directoryHref(previewUrl: string, origin: string): string {
  const abs = new URL(previewUrl, origin).href
  return abs.slice(0, abs.lastIndexOf('/') + 1)
}
