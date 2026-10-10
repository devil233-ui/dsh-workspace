/*
 * @Description: Markdown 渲染管线测试 —— front matter、目录抽取、占位与增强替换
 * @Author: YangHeng
 * @Date: 2026-10-10 12:30:00
 * @FilePath: /dsh-workspace/src/client/viewers/markdown-render.test.ts
 */
import { describe, expect, it } from 'vitest'
import { enhanceMarkdownBody, frontMatterHtml, renderMarkdownBody, slugify, splitFrontMatter } from './markdown-render.js'
import { stripActiveTags } from '../sidebar/markdown.js'

describe('splitFrontMatter', () => {
  it('YAML：拆出键值并返回正文', () => {
    const r = splitFrontMatter('---\ntitle: "你好"\ndate: 2026-10-10\n---\n# 正文\n')
    expect(r.frontMatter?.format).toBe('yaml')
    expect(r.frontMatter?.fields).toEqual([['title', '你好'], ['date', '2026-10-10']])
    expect(r.body).toBe('# 正文\n')
  })

  it('TOML（+++）', () => {
    const r = splitFrontMatter('+++\ntitle = "x"\n+++\nbody')
    expect(r.frontMatter).toMatchObject({ format: 'toml', fields: [['title', 'x']] })
    expect(r.body).toBe('body')
  })

  it('嵌套结构不硬解析，只给原文', () => {
    const r = splitFrontMatter('---\ntags:\n  - a\n  - b\n---\nx')
    expect(r.frontMatter?.fields).toBeUndefined()
    expect(r.frontMatter?.raw).toContain('- a')
  })

  it('不在第一行 / 没闭合的 --- 不是 front matter（是分隔线）', () => {
    expect(splitFrontMatter('# t\n---\na: b\n---\n').frontMatter).toBeUndefined()
    expect(splitFrontMatter('---\na: b\n').frontMatter).toBeUndefined()
  })

  it('front matter 渲染转义', () => {
    const html = frontMatterHtml({ raw: '', format: 'yaml', fields: [['a', '<b>']] }, '属性')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>')
  })
})

describe('目录（TOC）', () => {
  it('收集 1–4 级标题，锚点 GitHub 风格且同名去重，中文保留', () => {
    const body = renderMarkdownBody('# 介绍\n## Getting Started!\n## Getting Started!\n##### 太深\n### `code` 标题')
    expect(body.toc).toEqual([
      { depth: 1, text: '介绍', id: '介绍' },
      { depth: 2, text: 'Getting Started!', id: 'getting-started' },
      { depth: 2, text: 'Getting Started!', id: 'getting-started-1' },
      { depth: 3, text: 'code 标题', id: 'code-标题' }
    ])
    expect(body.html).toContain('<h2 id="getting-started-1">')
  })

  it('slugify 空标题兜底', () => {
    expect(slugify('!!!', new Map())).toBe('section')
  })
})

describe('占位', () => {
  it('代码块 / mermaid / 公式分别收集，未增强时显示原文', () => {
    const body = renderMarkdownBody('```js\nconst a = 1 < 2\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n行内 $x^2$ 与价格 $5 和 $10\n\n$$\n\\sum_i i\n$$\n')
    expect(body.code).toEqual([{ lang: 'js', text: 'const a = 1 < 2' }])
    expect(body.mermaid).toEqual(['graph TD; A-->B'])
    expect(body.math).toEqual([{ tex: 'x^2', display: false }, { tex: '\\sum_i i', display: true }])
    expect(body.html).toContain('1 &lt; 2')
    expect(body.html).toContain('data-mermaid="0"')
  })

  it('增强：替换为高亮 / MathML / SVG；mermaid 失败时保留原文并附错误', async () => {
    const body = renderMarkdownBody('```js\nlet a\n```\n\n$a$\n\n```mermaid\nbad\n```\n')
    const html = await enhanceMarkdownBody(
      body,
      async () => ({
        highlight: async (c) => `<span class="hljs-keyword">${c}</span>`,
        renderMath: async (tex) => `<math>${tex}</math>`,
        renderMermaid: async () => {
          throw new Error('Parse error')
        }
      }),
      false,
      new Map(),
      { mermaidError: (m) => `ERR ${m}`, zoom: 'zoom' }
    )
    expect(html).toContain('<code class="hljs language-js"><span class="hljs-keyword">let a</span></code>')
    expect(html).toContain('<math>a</math>')
    expect(html).toContain('ERR Parse error')
    expect(html).toContain('bad')
  })

  it('增强资源加载失败：返回占位版，不抛错', async () => {
    const body = renderMarkdownBody('```js\nx\n```')
    const html = await enhanceMarkdownBody(body, () => Promise.reject(new Error('404')), false, new Map(), { mermaidError: (m) => m, zoom: '' })
    expect(html).toBe(body.html)
  })
})

describe('stripActiveTags', () => {
  it('【安全】去掉 meta / base / 脚本 / 嵌套框架 / 表单，保留任务列表勾选框', () => {
    const out = stripActiveTags('<meta http-equiv="refresh" content="0;url=https://x"><base href="https://x/"><script>alert(1)</script><iframe src="x"></iframe><form action="x"><p>ok</p></form><input type="checkbox" disabled>')
    expect(out).not.toMatch(/<meta|<base|<script|<iframe|<form/i)
    expect(out).toContain('<p>ok</p>')
    expect(out).toContain('<input type="checkbox" disabled>')
  })
})
