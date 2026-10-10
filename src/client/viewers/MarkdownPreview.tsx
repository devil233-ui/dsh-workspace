/*
 * @Description: Markdown 增强预览 —— 代码高亮 / KaTeX / Mermaid（点击放大）/ front matter / 浮动目录 / 选区「加入对话」
 * @Author: YangHeng
 * @Date: 2026-10-10 12:10:00
 * @FilePath: /dsh-workspace/src/client/viewers/MarkdownPreview.tsx
 *
 * 安全取舍（为什么是「父文档离屏渲染 + 无脚本 iframe」，而不是「iframe 里允许受控脚本」）：
 * - Markdown 可夹带任意 HTML。只要 iframe 能跑脚本，就要靠白名单清洗来兜底，漏一个属性就是 XSS；
 *   而 sandbox 不给 allow-scripts 时，浏览器保证页面里一行脚本都不会执行，与内容无关。
 * - highlight.js / KaTeX / Mermaid 都能在父文档里离屏产出静态 HTML / SVG（Mermaid 用 securityLevel:'strict'），
 *   结果拼进 iframe 即可，iframe 不需要任何脚本能力。
 * - iframe 额外给 allow-same-origin（仍无 allow-scripts）：让父文档能读选区（加入对话）、处理目录跳转、点击图表放大、
 *   内容更新时原地替换正文（保持滚动位置）。没有脚本能力时同源标志对页面自身没有意义。
 * 图表放大用 <img src="data:image/svg+xml"> 显示：作为图片的 SVG 不会执行任何脚本，也不进入 DSH 的 DOM。
 */
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { Translate } from '../context.js'
import { markdownPage, stripActiveTags, directoryHref } from '../sidebar/markdown.js'
import { fallbackReader, inlineHtml, type DataReader } from '../sidebar/inline-preview.js'
import { enhanceMarkdownBody, frontMatterHtml, renderMarkdownBody, type MarkdownExtras, type TocItem } from './markdown-render.js'
import { loadViewerEntry } from './lazy-load.js'
import { insertIntoComposer, quoteForChat } from './composer.js'
import type { FileIO } from './io.js'

export interface MarkdownPreviewProps {
  t: Translate
  io: FileIO
  /** 当前内容（含代码视图里未保存的草稿）。 */
  content: string
  /** 文件路径（相对图片的基准）。 */
  path: string
  /** 工作区根（/ 开头的引用以它为基准）。 */
  root: string
  /** 内联相对资源（桌面版 / 没有预览路由时）；否则用 <base> 指向预览路由。 */
  inline: boolean
  dark: boolean
  /** 引用出处（加入对话时附在引文后）。 */
  source: string
  nonce: number
}

const extras = (): Promise<MarkdownExtras> => loadViewerEntry('markdown-extras')

/** svg 字符串 → 放大视图用的尺寸（取 viewBox，缺省 800×600）。 */
function svgSize(svg: string): { w: number; h: number } {
  const m = /viewBox="[\d.-]+[\s,]+[\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(svg)
  return m === null ? { w: 800, h: 600 } : { w: Number(m[1]), h: Number(m[2]) }
}

export function MarkdownPreview(props: MarkdownPreviewProps) {
  const { t, io, content, path, root, inline, dark, source, nonce } = props
  const wrapRef = useRef<HTMLDivElement>(null)
  const frameRef = useRef<HTMLIFrameElement>(null)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [baseHref, setBaseHref] = useState<string | null | undefined>(undefined)
  const [toc, setToc] = useState<TocItem[]>([])
  const [tocOpen, setTocOpen] = useState(false)
  const [quote, setQuote] = useState<{ text: string; x: number; y: number } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [zoom, setZoom] = useState<{ svg: string } | null>(null)
  const cache = useMemo(() => new Map<string, string>(), [])
  const docReady = useRef(false)

  // 带缓存的内联读取器：每次重渲染（保存 / 刷新）都会走内联，同一张图片只取一次。
  const reader = useMemo<DataReader>(() => {
    const memo = new Map<string, Promise<string | undefined>>()
    const base = fallbackReader((p) => io.readData(p), (p) => io.readTextOf(p), [])
    return (p) => {
      let hit = memo.get(p)
      if (hit === undefined) {
        hit = base(p)
        memo.set(p, hit)
      }
      return hit
    }
  }, [io])

  // 网页版：<base> 指向预览路由所在目录（相对图片同源加载）；取不到预览地址时退回内联。
  useEffect(() => {
    if (inline) {
      setBaseHref(null)
      return
    }
    let alive = true
    io.previewUrl(path).then(
      (url) => alive && setBaseHref(url === undefined ? null : directoryHref(url, window.location.origin)),
      () => alive && setBaseHref(null)
    )
    return () => {
      alive = false
    }
  }, [io, path, inline])

  // 渲染：同步出占位版 → 异步增强 → （需要时）内联相对资源；首帧建 iframe，之后原地替换正文。
  useEffect(() => {
    if (baseHref === undefined) return
    let alive = true
    const timer = setTimeout(() => {
      const body = renderMarkdownBody(content)
      setToc(body.toc)
      const head = frontMatterHtml(body.frontMatter, t('viewer.frontMatter'))
      body.html = head + stripActiveTags(body.html)
      void (async () => {
        let html = await enhanceMarkdownBody(body, extras, dark, cache, {
          mermaidError: (message) => t('viewer.mermaidError', { message }),
          zoom: t('viewer.mermaidZoom')
        })
        if (baseHref === null) html = await inlineHtml(html, path, root, reader).catch(() => html)
        if (!alive) return
        const doc = frameRef.current?.contentDocument
        if (docReady.current && doc?.body !== undefined && doc.body !== null) doc.body.innerHTML = html
        else setSrcDoc(markdownPage(html, baseHref ?? undefined, dark))
      })()
    }, srcDoc === null ? 0 : 250)
    return () => {
      alive = false
      clearTimeout(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, baseHref, dark, nonce])

  // 主题 / 基址变化：整页重建。
  useEffect(() => {
    docReady.current = false
    setSrcDoc(null)
  }, [dark, baseHref, nonce])

  /** iframe 加载后挂事件（父文档里的监听，iframe 自身仍不执行脚本）。 */
  const onLoad = (): void => {
    const frame = frameRef.current
    const doc = frame?.contentDocument
    if (frame === null || doc === null || doc === undefined) return
    docReady.current = true
    const updateQuote = (): void => {
      const sel = doc.getSelection()
      const text = sel?.toString().trim() ?? ''
      if (sel === null || text === '' || sel.rangeCount === 0) {
        setQuote(null)
        return
      }
      const rect = sel.getRangeAt(sel.rangeCount - 1).getBoundingClientRect()
      const width = frame.clientWidth
      setQuote({ text: sel.toString(), x: Math.min(Math.max(rect.right - 40, 8), width - 96), y: Math.min(rect.bottom + 6, frame.clientHeight - 32) })
    }
    doc.addEventListener('mouseup', () => setTimeout(updateQuote, 0))
    doc.addEventListener('keyup', (e) => {
      if (e.shiftKey || e.key.startsWith('Arrow')) updateQuote()
    })
    doc.addEventListener('scroll', () => setQuote(null))
    doc.addEventListener('click', (e) => {
      const target = e.target as Element | null
      const figure = target?.closest?.('.dshws-mermaid')
      const svg = figure?.querySelector('svg')
      if (svg !== null && svg !== undefined) {
        setZoom({ svg: svg.outerHTML })
        return
      }
      const a = target?.closest?.('a[href]') as HTMLAnchorElement | null | undefined
      if (a === null || a === undefined) return
      e.preventDefault()
      const href = a.getAttribute('href') ?? ''
      if (href.startsWith('#')) {
        doc.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' })
      } else if (/^https?:/i.test(href)) {
        window.open(href, '_blank', 'noopener,noreferrer')
      }
      // 其余（相对文件链接、mailto 等）不在预览里导航：沙箱页面导航出去会变成一个空白的无脚本页。
    })
  }

  const addToChat = async (): Promise<void> => {
    if (quote === null) return
    const result = await insertIntoComposer(quoteForChat(quote.text, source))
    setQuote(null)
    frameRef.current?.contentDocument?.getSelection()?.removeAllRanges()
    setNotice(result === 'inserted' ? t('viewer.addedToChat') : result === 'copied' ? t('viewer.addToChatCopied') : t('viewer.addToChatFailed'))
    setTimeout(() => setNotice(null), 2500)
  }

  return (
    <div className="dshws-md-preview" ref={wrapRef}>
      {srcDoc === null ? (
        <div className="dshws-tree-note">{t('files.loading')}</div>
      ) : (
        <iframe
          key={`${dark}|${nonce}|${baseHref ?? ''}`}
          ref={frameRef}
          className="dshws-side-frame"
          title={path.slice(path.lastIndexOf('/') + 1)}
          // 无 allow-scripts：页面里任何脚本都不执行；allow-same-origin 只为父文档读选区 / 处理点击（见文件头）。
          sandbox="allow-same-origin"
          srcDoc={srcDoc}
          onLoad={onLoad}
        />
      )}
      {toc.length > 0 ? (
        <div className="dshws-md-toc" data-open={tocOpen}>
          <button type="button" className="dshws-md-toc-btn" title={t('viewer.toc')} onClick={() => setTocOpen(!tocOpen)}>
            ☰
          </button>
          {tocOpen ? (
            <nav className="dshws-md-toc-list" aria-label={t('viewer.toc')}>
              {toc.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  style={{ paddingLeft: 8 + (item.depth - 1) * 12 }}
                  title={item.text}
                  onClick={() => frameRef.current?.contentDocument?.getElementById(item.id)?.scrollIntoView({ block: 'start' })}
                >
                  {item.text}
                </button>
              ))}
            </nav>
          ) : null}
        </div>
      ) : null}
      {quote !== null ? (
        <button type="button" className="dshws-md-quote" style={{ left: quote.x, top: quote.y }} onMouseDown={(e) => e.preventDefault()} onClick={() => void addToChat()}>
          {t('viewer.addToChat')}
        </button>
      ) : null}
      {notice !== null ? <div className="dshws-md-notice">{notice}</div> : null}
      {zoom !== null ? <SvgZoom svg={zoom.svg} hint={t('viewer.zoomHint')} closeLabel={t('common.close')} onClose={() => setZoom(null)} /> : null}
    </div>
  )
}

/** 图表放大：滚轮缩放、拖动平移、双击还原、Esc / 点背景关闭。 */
function SvgZoom(props: { svg: string; hint: string; closeLabel: string; onClose(): void }) {
  const { w, h } = svgSize(props.svg)
  const src = useMemo(() => {
    // 作为独立图片需要命名空间与明确尺寸；mermaid 的 width="100%" 在 <img> 里会退化成默认 300×150。
    let s = props.svg.replace(/\swidth="[^"]*"/, ` width="${w}"`)
    if (!/\sheight="/.test(s.slice(0, s.indexOf('>')))) s = s.replace('<svg', `<svg height="${h}"`)
    if (!s.includes('xmlns="http://www.w3.org/2000/svg"')) s = s.replace('<svg', '<svg xmlns="http://www.w3.org/2000/svg"')
    return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(s)}`
  }, [props.svg, w, h])
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const drag = useRef<{ x: number; y: number; ox: number; oy: number } | null>(null)
  const onClose = props.onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const down = (e: ReactPointerEvent<HTMLDivElement>): void => {
    drag.current = { x: e.clientX, y: e.clientY, ox: view.x, oy: view.y }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const move = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const d = drag.current
    if (d !== null) setView((v) => ({ ...v, x: d.ox + e.clientX - d.x, y: d.oy + e.clientY - d.y }))
  }
  return (
    <div className="dshws-zoom" role="dialog" aria-label={props.hint} onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div
        className="dshws-zoom-stage"
        onPointerDown={down}
        onPointerMove={move}
        onPointerUp={() => (drag.current = null)}
        onDoubleClick={() => setView({ scale: 1, x: 0, y: 0 })}
        onWheel={(e) => setView((v) => ({ ...v, scale: Math.min(8, Math.max(0.2, v.scale * (e.deltaY < 0 ? 1.15 : 1 / 1.15))) }))}
      >
        <img src={src} alt="" draggable={false} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`, maxWidth: 'none' }} />
      </div>
      <div className="dshws-zoom-bar">
        <span>{props.hint}</span>
        <button type="button" className="dshws-link-btn" onClick={onClose}>
          {props.closeLabel}
        </button>
      </div>
    </div>
  )
}
