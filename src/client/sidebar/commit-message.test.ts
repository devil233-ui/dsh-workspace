import { describe, expect, it } from 'vitest'
import { renderCommitBody, safeHref } from './commit-message.js'

describe('renderCommitBody：Markdown 渲染', () => {
  it('列表、行内代码、代码块、单个换行保留', () => {
    const html = renderCommitBody('- 一 `a<b>`\n- 二\n\n第一行\n第二行\n\n```\nx < y\n```')
    expect(html).toContain('<ul>')
    expect(html).toContain('<code>a&lt;b&gt;</code>')
    expect(html).toContain('第一行<br>')
    expect(html).toContain('x &lt; y')
  })

  it('空正文返回空串', () => {
    expect(renderCommitBody('  \n ')).toBe('')
  })
})

describe('renderCommitBody：XSS 安全', () => {
  const cases = [
    '<script>alert(1)</script>',
    '<img src=x onerror=alert(1)>',
    'text <svg onload=alert(1)> more',
    '<iframe src="https://evil"></iframe>',
    '<a href="javascript:alert(1)">x</a>',
    '<details open ontoggle=alert(1)>',
    '<style>body{display:none}</style>'
  ]
  for (const src of cases) {
    it(`原始 HTML 一律转义：${src}`, () => {
      const html = renderCommitBody(src)
      // 不应生成任何真实的标签开头（只允许 marked 自己的 <p>）
      expect(html.replace(/<\/?p>/g, '')).not.toMatch(/<[a-z]/i)
      expect(html).toContain('&lt;')
    })
  }

  it('危险协议的链接降级为纯文本', () => {
    for (const href of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'java%0ascript:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x']) {
      const html = renderCommitBody(`[点我](${href})`)
      expect(html).not.toContain('<a')
      expect(html).toContain('点我')
    }
  })

  it('安全链接新窗口打开且不带 opener，属性值已转义', () => {
    const html = renderCommitBody('[文档](https://example.com/a?x=1&y="2") 和 <https://example.com/b>')
    expect(html).toContain('target="_blank"')
    expect(html).toContain('rel="noopener noreferrer"')
    expect(html).not.toMatch(/href="[^"]*"2"/)
    expect(html.match(/<a /g)).toHaveLength(2)
  })

  it('图片不加载，降级为链接；非法协议的图片只剩文字', () => {
    expect(renderCommitBody('![截图](https://example.com/x.png)')).not.toContain('<img')
    expect(renderCommitBody('![截图](https://example.com/x.png)')).toContain('<a href="https://example.com/x.png"')
    expect(renderCommitBody('![x"onerror=1](javascript:1)')).not.toMatch(/<(img|a)\b/)
  })

  it('safeHref：只放行 http(s) / mailto', () => {
    expect(safeHref('https://a.b')).toBe('https://a.b')
    expect(safeHref('mailto:a@b.c')).toBe('mailto:a@b.c')
    expect(safeHref(' java\tscript:1')).toBeNull()
    expect(safeHref('/relative')).toBeNull()
  })
})
