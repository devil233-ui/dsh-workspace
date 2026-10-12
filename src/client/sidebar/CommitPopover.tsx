/*
 * @Description: Git「历史」提交说明浮窗 —— 悬停 / 聚焦提交行时显示标题、作者、时间、短 hash 与 Markdown 正文；
 *               移动端（长按 / 「说明」按钮）改为屏幕居中的模态弹窗
 * @Author: YangHeng
 * @Date: 2026-10-10 18:30:00
 * @FilePath: /dsh-workspace/src/client/sidebar/CommitPopover.tsx
 *
 * 为什么用 portal 挂到 body：侧栏列表是滚动容器（overflow 会裁掉子元素），浮窗又要伸出侧栏进主区，
 * 只能 position: fixed 挂在 body 上（与右键菜单 / 浮动提示同一做法）。定位与计时的纯逻辑见 commit-popover.ts。
 */
import { createContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { GitCommit } from '../../git/parse.js'
import type { SidebarBodyProps } from './RemoteFileTab.js'
import { copyText } from './ContextMenu.js'
import { renderCommitBody } from './commit-message.js'
import { createHoverIntent, placeCommitPopover, type HoverIntent, type PopoverSide } from './commit-popover.js'
import { IconClose } from '../icons.js'

/**
 * GitTab 所在容器决定浮窗首选方向：右侧栏（默认）放行的左侧，会话顶部标签页（主区）放行的右侧。
 * 为什么用 context 而不是层层传 prop：GitTab 的 props 是宿主插槽统一的 SidebarBodyProps，
 * 历史列表又嵌在好几层视图里，只有注册会话顶部标签处（register.tsx）需要改这个值。
 */
export const CommitPopoverSideContext = createContext<PopoverSide>('left')

/** 悬停意图 hook：返回当前显示的 key 与控制器（组件卸载时清掉计时器）。 */
export function useHoverIntent<K>(): [K | null, HoverIntent<K>] {
  const [shown, setShown] = useState<K | null>(null)
  const ref = useRef<HoverIntent<K> | null>(null)
  if (ref.current === null) ref.current = createHoverIntent<K>(setShown)
  useEffect(() => () => ref.current?.dispose(), [])
  return [shown, ref.current]
}

/** 模态弹窗压入的历史记录标记：手机「返回」先关弹窗，而不是离开页面。 */
const HISTORY_MARK = 'dshwsCommitModal'

interface Props {
  t: SidebarBodyProps['t']
  commit: GitCommit
  /** 悬停浮窗定位用；模态弹窗不需要。 */
  anchor?: HTMLElement
  intent: HoverIntent<string>
  raw: boolean
  onRaw(raw: boolean): void
  /** 悬停浮窗的首选方向。 */
  side: PopoverSide
  /** true = 屏幕居中的模态弹窗（移动端）。 */
  modal: boolean
}

export function CommitPopover(props: Props) {
  const { t, commit, anchor, intent, raw, side, modal } = props
  const ref = useRef<HTMLDivElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  // 遮罩只在「按下也在遮罩上」时才关：长按松手时补发的 click 可能落在刚弹出的遮罩上，不能一弹出就被关掉。
  const maskDown = useRef(false)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)
  const [copied, setCopied] = useState(false)
  // 旧版服务端（升级过渡期）不返回 body：按无正文处理。
  const body = typeof commit.body === 'string' ? commit.body : ''
  // html 已在 renderCommitBody 里消毒（原始 HTML 转义、链接协议白名单、图片不加载），见 commit-message.ts。
  const html = useMemo(() => (raw || body === '' ? '' : renderCommitBody(body)), [raw, body])

  // 先以 visibility: hidden 渲染量出真实尺寸，再按行位置算坐标；切换「渲染 / 原文」会改变高度，也要重算。
  useLayoutEffect(() => {
    const el = ref.current
    if (modal || el === null || anchor === undefined) return
    const r = el.getBoundingClientRect()
    const a = anchor.getBoundingClientRect()
    const p = placeCommitPopover(a, { width: r.width, height: r.height }, { width: window.innerWidth, height: window.innerHeight }, { prefer: side })
    setPos({ left: p.left, top: p.top })
  }, [anchor, commit.hash, raw, side, modal])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') intent.close()
    }
    // 悬停浮窗：列表滚动后行已移走，浮窗留在原处会指错行，直接关；浮窗自己内部滚动不算。
    // 模态弹窗居中、不跟行走，滚动不关。
    const onScroll = (e: Event): void => {
      if (modal || ref.current?.contains(e.target as Node) === true) return
      intent.close()
    }
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      document.removeEventListener('keydown', onKey, true)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [intent, modal])

  // 模态弹窗：聚焦关闭按钮（键盘 / 读屏可直接操作），并压一条历史记录，让手机「返回」键 / 手势只关弹窗。
  useEffect(() => {
    if (!modal) return undefined
    closeRef.current?.focus({ preventScroll: true })
    let popped = false
    // 保留宿主路由写在 history.state 里的字段（如 react-router 的 idx / key），只追加自己的标记。
    const base = history.state !== null && typeof history.state === 'object' ? (history.state as Record<string, unknown>) : {}
    history.pushState({ ...base, [HISTORY_MARK]: true }, '')
    const onPop = (): void => {
      popped = true
      intent.close()
    }
    window.addEventListener('popstate', onPop)
    return () => {
      window.removeEventListener('popstate', onPop)
      // 用 Esc / 遮罩 / 关闭按钮关的：把自己压的那条记录退掉，避免用户之后按「返回」原地不动一次。
      const state = history.state as Record<string, unknown> | null
      if (!popped && state !== null && typeof state === 'object' && state[HISTORY_MARK] === true) history.back()
    }
  }, [modal, intent])

  useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1200)
    return () => clearTimeout(timer)
  }, [copied])

  const merge = commit.parents.length > 1
  const card = (
    <div
      ref={ref}
      id={`dshws-git-pop-${commit.hash}`}
      className="dshws-git-pop"
      data-modal={modal ? 'true' : undefined}
      role="dialog"
      aria-modal={modal ? true : undefined}
      aria-label={t('git.msg.label')}
      style={modal ? undefined : pos === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: pos.left, top: pos.top }}
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
        {modal ? (
          <button ref={closeRef} type="button" className="dshws-ibtn dshws-git-pop-close" title={t('common.close')} aria-label={t('common.close')} onClick={() => intent.close()}>
            <IconClose size={14} />
          </button>
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
    </div>
  )
  return createPortal(
    modal ? (
      <div
        className="dshws-git-pop-mask"
        onPointerDown={(e) => {
          maskDown.current = e.target === e.currentTarget
        }}
        onClick={(e) => {
          if (e.target === e.currentTarget && maskDown.current) intent.close()
          maskDown.current = false
        }}
      >
        {card}
      </div>
    ) : (
      card
    ),
    document.body
  )
}
