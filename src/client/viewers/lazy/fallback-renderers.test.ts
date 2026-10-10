/*
 * @Description: file-viewer 兜底渲染器测试（未装配类别全覆盖、文本兜底的截断与二进制判定、中英文文案）
 * @Author: YangHeng
 * @Date: 2026-10-10 15:10:00
 * @FilePath: /dsh-workspace/src/client/viewers/lazy/fallback-renderers.test.ts
 */
import { describe, expect, it } from 'vitest'
import { DEFAULT_RENDERER_DEFINITIONS } from '@file-viewer/core'
import type { FileViewerRendererPlugin } from '@file-viewer/core'
import { fallbackRenderers, renderPlainText, renderUnsupportedNotice, TEXT_FALLBACK_MAX_BYTES } from './fallback-renderers.js'

/** vitest 跑在 node 环境、没有 DOM：用最小替身记录渲染结果（只实现兜底渲染器用到的接口）。 */
interface FakeEl { tag: string, textContent: string, children: FakeEl[], attrs: Record<string, string>, style: { cssText: string } }
function fakeTarget(): { target: HTMLElement, root: { children: FakeEl[] } } {
  const make = (tag: string): FakeEl & { appendChild(c: FakeEl): void, setAttribute(k: string, v: string): void } => {
    const el = { tag, textContent: '', children: [] as FakeEl[], attrs: {} as Record<string, string>, style: { cssText: '' } }
    return Object.assign(el, { appendChild: (c: FakeEl) => { el.children.push(c) }, setAttribute: (k: string, v: string) => { el.attrs[k] = v } })
  }
  const root = { children: [] as FakeEl[] }
  const target = { ownerDocument: { createElement: make }, replaceChildren: (...c: FakeEl[]) => { root.children = c } }
  return { target: target as unknown as HTMLElement, root }
}

const zh = { options: { locale: 'zh-CN' } } as never
const en = { options: { locale: 'en-US' } } as never
const bytes = (s: string): ArrayBuffer => new TextEncoder().encode(s).buffer as ArrayBuffer

describe('fallbackRenderers', () => {
  const installed: FileViewerRendererPlugin[] = [
    { id: 'word', definitions: DEFAULT_RENDERER_DEFINITIONS.filter((d) => d.id === 'office-word-binary' || d.id === 'pdf') }
  ]
  const [plugin] = fallbackRenderers(installed)

  it('覆盖矩阵中所有未装配类别，且不重复注册已装配的', () => {
    const ids = (plugin?.definitions ?? []).map((d) => d.id)
    expect(ids).toContain('office-presentation-binary')
    expect(ids).toContain('cad')
    expect(ids).toContain('code')
    expect(ids).not.toContain('office-word-binary')
    expect(ids).not.toContain('pdf')
    expect(ids.length).toBe(DEFAULT_RENDERER_DEFINITIONS.length - 2)
    // 每个定义都有对应 handler，否则 file-viewer 仍会提示「未装配」
    expect((plugin?.handlers ?? []).map((h) => h.rendererId).sort()).toEqual([...ids].sort())
  })

  it('code / markdown 走纯文本，其余走不支持提示', () => {
    const handlerOf = (id: string) => plugin?.handlers?.find((h) => h.rendererId === id)?.handler
    expect(handlerOf('code')).toBe(renderPlainText)
    expect(handlerOf('markdown')).toBe(renderPlainText)
    expect(handlerOf('office-presentation-binary')).toBe(renderUnsupportedNotice)
    expect(handlerOf('cad')).toBe(renderUnsupportedNotice)
  })

  it('全部类别都已装配时不生成兜底', () => {
    const all: FileViewerRendererPlugin = { id: 'all', definitions: DEFAULT_RENDERER_DEFINITIONS }
    expect(fallbackRenderers([all])).toEqual([])
  })
})

describe('兜底渲染', () => {
  it('不支持提示：按 file-viewer 语言出中英文', async () => {
    const a = fakeTarget()
    await renderUnsupportedNotice(new ArrayBuffer(0), a.target, 'ppt', zh)
    expect(a.root.children[0]?.textContent).toBe('该格式不支持在线预览，请下载后用系统应用打开')
    const b = fakeTarget()
    await renderUnsupportedNotice(new ArrayBuffer(0), b.target, 'ppt', en)
    expect(b.root.children[0]?.textContent).toMatch(/cannot be previewed online/)
  })

  it('纯文本：解码进 <pre>，HTML 只作为文本', async () => {
    const t = fakeTarget()
    await renderPlainText(bytes('<b>你好</b>\nline2'), t.target, 'html', zh)
    const pre = t.root.children[0]?.children.find((c) => c.tag === 'pre')
    expect(pre?.textContent).toBe('<b>你好</b>\nline2')
  })

  it('纯文本：超过上限只解码开头并注明', async () => {
    const big = new Uint8Array(TEXT_FALLBACK_MAX_BYTES + 10).fill(0x61)
    const t = fakeTarget()
    await renderPlainText(big.buffer, t.target, 'txt', zh)
    const wrap = t.root.children[0]
    expect(wrap?.children[0]?.textContent).toMatch(/仅显示前 2 MB/)
    expect(wrap?.children.find((c) => c.tag === 'pre')?.textContent.length).toBe(TEXT_FALLBACK_MAX_BYTES)
  })

  it('纯文本：含 NUL 字节视为二进制，改为不支持提示', async () => {
    const t = fakeTarget()
    await renderPlainText(new Uint8Array([0x61, 0, 0x62]).buffer, t.target, 'json', zh)
    expect(t.root.children[0]?.attrs['data-dshws-fallback']).toBe('unsupported')
  })
})
