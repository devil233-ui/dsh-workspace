/*
 * @Description: Markdown 渲染管线 —— front matter、目录（TOC）、代码块 / 公式 / Mermaid 占位与按需增强
 * @Author: YangHeng
 * @Date: 2026-10-10 11:50:00
 * @FilePath: /dsh-workspace/src/client/viewers/markdown-render.ts
 *
 * 两段式：
 * 1. renderMarkdownBody（同步、纯字符串，可在 Node 单测）：marked 出 HTML，同时收集标题 / 代码块 / 公式 / 图表，
 *    在原位留下占位（代码块先输出未高亮版本，公式先输出 TeX 原文）—— 增强资源没加载完也能先看到内容。
 * 2. enhanceMarkdownBody（异步）：按需加载 highlight.js / KaTeX / Mermaid（见 lazy/markdown-extras-entry.ts），
 *    在父文档里离屏渲染成静态 HTML / SVG 再替换占位。产物最终放进无脚本 iframe，iframe 里从不执行脚本。
 */
import { Marked, type Tokens } from 'marked'

export interface TocItem {
  depth: number
  text: string
  id: string
}

export interface FrontMatter {
  /** 原文（不含分隔线）。 */
  raw: string
  /** 能按「key: value」逐行解析时的键值对；有嵌套结构时为 undefined，界面改为显示原文。 */
  fields?: Array<[string, string]>
  format: 'yaml' | 'toml'
}

export interface MarkdownBody {
  html: string
  toc: TocItem[]
  frontMatter?: FrontMatter
  code: Array<{ lang: string; text: string }>
  math: Array<{ tex: string; display: boolean }>
  mermaid: string[]
}

export interface MarkdownExtras {
  highlight(code: string, lang: string): Promise<string | undefined>
  renderMath(tex: string, display: boolean): Promise<string>
  renderMermaid(code: string, dark: boolean): Promise<string>
}

const escapeHtml = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

/**
 * 拆出文件开头的 front matter（YAML `---` 或 TOML `+++`），只认第一行就是分隔线的写法（与 GitHub / Hugo 一致）。
 */
export function splitFrontMatter(markdown: string): { frontMatter?: FrontMatter; body: string } {
  const src = markdown.replace(/^\uFEFF/, '')
  const m = /^(---|\+\+\+)[ \t]*\r?\n([\s\S]*?)\r?\n\1[ \t]*(?:\r?\n|$)/.exec(src)
  if (m === null) return { body: markdown }
  const raw = m[2] ?? ''
  const format = m[1] === '+++' ? 'toml' : 'yaml'
  const fields: Array<[string, string]> = []
  let simple = true
  for (const line of raw.split(/\r?\n/)) {
    if (line.trim() === '' || /^\s*#/.test(line)) continue
    const kv = format === 'yaml' ? /^([A-Za-z0-9_][\w.-]*)\s*:\s*(.*)$/.exec(line) : /^([A-Za-z0-9_][\w.-]*)\s*=\s*(.*)$/.exec(line)
    // 缩进行 / 列表项 / 无键行 = 嵌套结构：不硬解析，整体按原文显示。
    if (kv === null || /^\s/.test(line)) {
      simple = false
      break
    }
    fields.push([kv[1] as string, unquote((kv[2] ?? '').trim())])
  }
  // 值为空的键后面通常跟着嵌套块，按原文显示更稳。
  if (fields.some(([, v]) => v === '')) simple = false
  return { frontMatter: { raw, format, ...(simple && fields.length > 0 ? { fields } : {}) }, body: src.slice(m[0].length) }
}

function unquote(v: string): string {
  return /^(["']).*\1$/.test(v) ? v.slice(1, -1) : v
}

/**
 * 标题锚点（GitHub 风格）：小写、去标点、空白换成 -；同名追加 -1、-2。中文等非 ASCII 字母保留。
 */
export function slugify(text: string, used: Map<string, number>): string {
  const base =
    text
      .trim()
      .toLowerCase()
      .replace(/<[^>]*>/g, '')
      .replace(/[^\p{L}\p{N}\s_-]/gu, '')
      .replace(/\s+/g, '-') || 'section'
  const n = used.get(base)
  used.set(base, n === undefined ? 1 : n + 1)
  return n === undefined ? base : `${base}-${n}`
}

/** HTML → 纯文本（目录显示用）。 */
function textOf(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 同步渲染（占位版）。 */
export function renderMarkdownBody(markdown: string): MarkdownBody {
  const { frontMatter, body } = splitFrontMatter(markdown)
  const toc: TocItem[] = []
  const code: MarkdownBody['code'] = []
  const math: MarkdownBody['math'] = []
  const mermaid: string[] = []
  const used = new Map<string, number>()

  // 每次新建实例：不污染全局 marked（GitTab 等仍用全局实例渲染简单预览）。
  const md = new Marked({ gfm: true, breaks: false, async: false })
  md.use({
    extensions: [
      {
        name: 'dshwsMathBlock',
        level: 'block',
        start: (src: string) => src.match(/^\$\$/m)?.index,
        tokenizer(src: string) {
          const m = /^\$\$([\s\S]+?)\$\$[ \t]*(?:\n|$)/.exec(src)
          return m === null ? undefined : { type: 'dshwsMathBlock', raw: m[0], text: (m[1] ?? '').trim() }
        },
        renderer(token) {
          math.push({ tex: String(token.text), display: true })
          return `<div class="dshws-math" data-display="1" data-math="${math.length - 1}">${escapeHtml(String(token.text))}</div>\n`
        }
      },
      {
        name: 'dshwsMathInline',
        level: 'inline',
        start: (src: string) => src.indexOf('$') === -1 ? undefined : src.indexOf('$'),
        tokenizer(src: string) {
          // $ 后不能紧跟空白、结束 $ 前不能是空白、后面不能紧跟数字 —— 避免把「$5 和 $10」当成公式。
          const m = /^\$(?!\s)((?:\\.|[^\\$\n])+?)(?<!\s)\$(?!\d)/.exec(src)
          return m === null ? undefined : { type: 'dshwsMathInline', raw: m[0], text: m[1] ?? '' }
        },
        renderer(token) {
          math.push({ tex: String(token.text), display: false })
          return `<span class="dshws-math" data-math="${math.length - 1}">${escapeHtml(String(token.text))}</span>`
        }
      }
    ],
    renderer: {
      heading(this: { parser: { parseInline(tokens: Tokens.Heading['tokens']): string } }, token: Tokens.Heading): string {
        const inner = this.parser.parseInline(token.tokens)
        const text = textOf(inner)
        const id = slugify(text, used)
        if (token.depth <= 4) toc.push({ depth: token.depth, text, id })
        return `<h${token.depth} id="${escapeHtml(id)}">${inner}</h${token.depth}>\n`
      },
      code(token: Tokens.Code): string {
        const lang = (token.lang ?? '').trim().split(/\s+/)[0] ?? ''
        if (lang.toLowerCase() === 'mermaid') {
          mermaid.push(token.text)
          return `<figure class="dshws-mermaid" data-mermaid="${mermaid.length - 1}"><pre><code>${escapeHtml(token.text)}</code></pre></figure>\n`
        }
        if (lang.toLowerCase() === 'math' || lang.toLowerCase() === 'latex' || lang.toLowerCase() === 'katex') {
          math.push({ tex: token.text, display: true })
          return `<div class="dshws-math" data-display="1" data-math="${math.length - 1}">${escapeHtml(token.text)}</div>\n`
        }
        code.push({ lang, text: token.text })
        const cls = lang === '' ? '' : ` class="language-${escapeHtml(lang)}"`
        return `<pre data-code="${code.length - 1}"><code${cls}>${escapeHtml(token.text)}</code></pre>\n`
      }
    }
  })
  const html = md.parse(body) as string
  return { html, toc, ...(frontMatter !== undefined ? { frontMatter } : {}), code, math, mermaid }
}

/** front matter → HTML（键值表；嵌套结构显示原文）。 */
export function frontMatterHtml(fm: FrontMatter | undefined, title: string): string {
  if (fm === undefined) return ''
  const inner =
    fm.fields !== undefined
      ? `<table>${fm.fields.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('')}</table>`
      : `<pre>${escapeHtml(fm.raw)}</pre>`
  return `<details class="dshws-front-matter" open><summary>${escapeHtml(title)}</summary>${inner}</details>\n`
}

/**
 * 增强：替换占位。各类增强互不影响 —— 某一类加载失败只保留占位原文（并把错误附在图表下方），不影响其余内容。
 * @param cache 渲染结果缓存（实时预览时每次按键都会重渲染，代码块 / 图表内容没变就不重算）
 */
export async function enhanceMarkdownBody(
  body: MarkdownBody,
  extras: () => Promise<MarkdownExtras>,
  dark: boolean,
  cache: Map<string, string>,
  labels: { mermaidError: (message: string) => string; zoom: string }
): Promise<string> {
  if (body.code.length === 0 && body.math.length === 0 && body.mermaid.length === 0) return body.html
  let api: MarkdownExtras
  try {
    api = await extras()
  } catch (error) {
    console.warn('[dsh-workspace] Markdown 增强资源加载失败', error)
    return body.html
  }
  const memo = async (key: string, fn: () => Promise<string | undefined>): Promise<string | undefined> => {
    const hit = cache.get(key)
    if (hit !== undefined) return hit
    const value = await fn()
    if (value !== undefined) cache.set(key, value)
    return value
  }
  const [codeOut, mathOut, mermaidOut] = await Promise.all([
    Promise.all(body.code.map((c) => memo(`code\n${c.lang}\n${c.text}`, () => api.highlight(c.text, c.lang)).catch(() => undefined))),
    Promise.all(body.math.map((m) => memo(`math\n${m.display ? 1 : 0}\n${m.tex}`, () => api.renderMath(m.tex, m.display)).catch(() => undefined))),
    Promise.all(
      body.mermaid.map((src) =>
        memo(`mermaid\n${dark ? 1 : 0}\n${src}`, () => api.renderMermaid(src, dark)).then(
          (svg) => ({ svg }),
          (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) })
        )
      )
    )
  ])
  let html = body.html
  html = html.replace(/<pre data-code="(\d+)"><code([^>]*)>[\s\S]*?<\/code><\/pre>/g, (whole, i: string, attrs: string) => {
    const out = codeOut[Number(i)]
    if (out === undefined) return whole
    const cls = attrs.includes('class="') ? attrs.replace('class="', 'class="hljs ') : ' class="hljs"'
    return `<pre data-code="${i}"><code${cls}>${out}</code></pre>`
  })
  html = html.replace(/<(div|span) class="dshws-math"( data-display="1")? data-math="(\d+)">[\s\S]*?<\/\1>/g, (whole, tag: string, disp: string | undefined, i: string) => {
    const out = mathOut[Number(i)]
    return out === undefined ? whole : `<${tag} class="dshws-math"${disp ?? ''} data-math="${i}">${out}</${tag}>`
  })
  html = html.replace(/<figure class="dshws-mermaid" data-mermaid="(\d+)">[\s\S]*?<\/figure>/g, (whole, i: string) => {
    const out = mermaidOut[Number(i)]
    if (out === undefined) return whole
    if ('error' in out) return whole.replace('</figure>', `<figcaption class="dshws-mermaid-error">${escapeHtml(labels.mermaidError(out.error ?? ''))}</figcaption></figure>`)
    return `<figure class="dshws-mermaid" data-mermaid="${i}" title="${escapeHtml(labels.zoom)}">${out.svg ?? ''}</figure>`
  })
  return html
}
