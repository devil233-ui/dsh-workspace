/*
 * @Description: Git「历史」提交说明浮窗 —— 悬停 / 聚焦提交行时显示标题、作者、时间、短 hash 与 Markdown 正文
 * @Author: YangHeng
 * @Date: 2026-10-10 18:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/CommitPopover.tsx
 *
 * 为什么用 portal 挂到 body：侧栏列表是滚动容器（overflow 会裁掉子元素），浮窗又要伸出侧栏进主区，
 * 只能 position: fixed 挂在 body 上（与右键菜单 / 浮动提示同一做法）。定位与计时的纯逻辑见 commit-popover.ts。
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitCommit } from '../../git/parse.js'
import type { SidebarBodyProps } from './RemoteFileTab.js'
import { copyText } from './ContextMenu.js'
import { renderCommitBody } from './commit-message.js'
import { createHoverIntent, placeCommitPopover, type HoverIntent } from './commit-popover.js'

/** 打开浮窗的触发按钮（触屏「说明」）带这个属性：点它时不算「点外面」，否则按下先关、松开又开，无法切换。 */
export const POPOVER_TRIGGER_ATTR = 'data-commit-pop-trigger'

/** 悬停意图 hook：返回当前显示的 key 与控制器（组件卸载时清掉计时器）。 */
export function useHoverIntent<K>(): [K | null, HoverIntent<K>] {
  const [shown, setShown] = useState<K | null>(null)
  const ref = useRef<HoverIntent<K> | null>(null)
  if (ref.current === null) ref.current = createHoverIntent<K>(setShown)
  useEffect(() => () => ref.current?.dispose(), [])
  return [shown, ref.current]
}

interface Props {
  t: SidebarBodyProps['t']
  commit: GitCommit
  anchor: HTMLElement
  intent: HoverIntent<string>
  raw: boolean
  onRaw(raw: boolean): void
}

export function CommitPopover(props: Props) {
  const { t, commit, anchor, intent, raw } = props
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [copied, setCopied] = useState(false)
  // 旧版服务端（升级过渡期）不返回 body：按无正文处理。
  const body = typeof commit.body === 'string' ? commit.body : ''
  // html 已在 renderCommitBody 里消毒（原始 HTML 转义、链接协议白名单、图片不加载），见 commit-message.ts。
  const html = useMemo(() => (raw || body === '' ? '' : renderCommitBody(body)), [raw, body])

  // 先以 visibility: hidden 渲染量出真实尺寸，再按行位置算坐标；切换「渲染 / 原文」会改变高度，也要重算。
  useLayoutEffect(() => {
    const el = ref.current
    if (el === null) return
    const r = el.getBoundingClientRect()
    const a = anchor.getBoundingClientRect()
    const p = placeCommitPopover(a, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight })
    setPos({ left: p.left, top: p.top })
  }, [anchor, commit.hash, raw])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') intent.close()
    }
    // 列表滚动后行已移走，浮窗留在原处会指错行，直接关；浮窗自己内部滚动不算。
    const onScroll = (e: Event): void => {
      if (ref.current?.contains(e.target as Node) === true) return
      intent.close()
    }
    // 只有点开（固定）的浮窗需要「点外面关闭」；悬停打开的随鼠标移出自然收起。
    const onDown = (e: MouseEvent): void => {
      if (!intent.pinned()) return
      const target = e.target as Element | null
      if (ref.current?.contains(target) === true || target?.closest?.(`[${POPOVER_TRIGGER_ATTR}]`) != null) return
      intent.close()
    }
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    document.addEventListener('mousedown', onDown, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
      document.removeEventListener('mousedown', onDown, true)
    }
  }, [intent])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  const merge = commit.parents.length > 1
  return createPortal(
    <div
      ref={ref}
      id={`dshws-git-pop-${commit.hash}`}
      className="dshws-git-pop"
      role="dialog"
      aria-label={t('git.msg.label')}
      style={pos === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: pos.left, top: pos.top }}
      onPointerEnter={() => intent.enterPopover()}
      onPointerLeave={() => intent.leavePopover()}
    >
      <div className="dshws-git-pop-head">
        <span className="dshws-git-pop-title">{commit.subject}</span>
        {body !== '' ? (
          <span className="dshws-side-seg" role="radiogroup">
            <button type="button" role="radio" aria-checked={!raw} data-active={!raw} onClick={() => props.onRaw(false)}>{t('git.msg.rendered')}</button>
            <button type="button" role="radio" aria-checked={raw} data-active={raw} onClick={() => props.onRaw(true)}>{t('git.msg.raw')}</button>
          </span>
        ) : null}
      </div>
      <div className="dshws-git-pop-meta">
        <span>{commit.author}</span>
        <span>{new Date(commit.date).toLocaleString()}</span>
        <button
          type="button"
          className="dshws-git-pop-hash dshws-mono"
          title={t('git.msg.copyHash')}
          onClick={() => void copyText(commit.hash).then(() => setCopied(true), () => undefined)}
        >
          {copied ? t('common.copied') : commit.hash.slice(0, 7)}
        </button>
        {merge ? <span className="dshws-pill">{t('git.mergeVsFirst')}</span> : null}
      </div>
      {body === '' ? null : raw ? (
        <pre className="dshws-git-pop-body" data-raw="true">{body}</pre>
      ) : (
        <div className="dshws-git-pop-body dshws-git-md" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </div>,
    document.body
  )
}
