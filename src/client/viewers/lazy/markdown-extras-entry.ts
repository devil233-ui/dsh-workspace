/*
 * @Description: Markdown 增强的按需加载入口（代码高亮 / KaTeX / Mermaid），单独打包成 lib/assets/viewers/markdown-extras.js
 * @Author: YangHeng
 * @Date: 2026-10-10 11:30:00
 * @FilePath: /dsh-workspace/src/client/viewers/lazy/markdown-extras-entry.ts
 *
 * 三者体量都不小（Mermaid 尤甚），所以本入口只放极薄的转发函数，真正的库各自动态 import、各成分片：
 * 文档里没有代码块 / 公式 / 图表时，对应的库一个字节都不会下载。
 *
 * 全部在父文档里离屏完成，产物是静态 HTML / SVG 字符串，再拼进无脚本沙箱 iframe —— iframe 里始终不执行任何脚本。
 */

/** highlight.js 渲染结果（带 hljs-* 类名的 HTML）；不认识的语言返回 undefined，调用方按纯文本显示。 */
export async function highlight(code: string, lang: string): Promise<string | undefined> {
  const { default: hljs } = await import('highlight.js/lib/common')
  const name = lang.trim().toLowerCase()
  if (name !== '' && hljs.getLanguage(name) !== undefined) return hljs.highlight(code, { language: name, ignoreIllegals: true }).value
  // 未标注语言的代码块不做自动识别：猜错比不高亮更糟，且自动识别要跑全部语法。
  return undefined
}

/**
 * KaTeX → MathML（output: 'mathml'）。
 * 选 MathML 而不是默认的 HTML+CSS 输出：后者依赖 KaTeX 样式表与十几个字体文件，
 * 在无同源权限的沙箱 iframe 里字体要跨源加载（需要 CORS，桌面版还拿不到令牌）；Chromium 109+ 原生渲染 MathML，零外部资源。
 */
export async function renderMath(tex: string, display: boolean): Promise<string> {
  const { default: katex } = await import('katex')
  return katex.renderToString(tex, { displayMode: display, output: 'mathml', throwOnError: false, strict: 'ignore', trust: false })
}

let mermaidReady: Promise<typeof import('mermaid').default> | undefined
let mermaidTheme: string | undefined
let seq = 0

/**
 * Mermaid → SVG 字符串。securityLevel 'strict'：图里的 HTML 标签被编码、点击回调被禁用，
 * 产物再放进无脚本 iframe，双重保证不会执行任何东西。
 */
export async function renderMermaid(code: string, dark: boolean): Promise<string> {
  mermaidReady ??= import('mermaid').then((m) => m.default)
  const mermaid = await mermaidReady
  const theme = dark ? 'dark' : 'default'
  if (mermaidTheme !== theme) {
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme, fontFamily: 'inherit' })
    mermaidTheme = theme
  }
  seq += 1
  const { svg } = await mermaid.render(`dshws-mermaid-${Date.now().toString(36)}-${seq}`, code)
  return svg
}
