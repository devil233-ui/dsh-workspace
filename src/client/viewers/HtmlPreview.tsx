/*
 * @Description: HTML / SVG 预览 —— 默认沙箱，可「临时解除沙箱」（本次页面会话对该文件有效）
 * @Author: YangHeng
 * @Date: 2026-10-10 12:10:00
 * @FilePath: /dsh-workspace/src/client/viewers/HtmlPreview.tsx
 *
 * 相对资源沿用原处理：网页版 iframe 直接加载预览路由（令牌鉴权，相对路径自然可用）；
 * 桌面版 / 没有预览路由（工作区外的本机文件）改为 srcdoc + 相对资源内联（见 sidebar/inline-preview.ts）。
 * 沙箱：默认 allow-scripts 但无 allow-same-origin（脚本可运行，但处在不透明源，碰不到 DSH 界面与接口）。
 * 解除沙箱 = iframe 不带 sandbox、预览路由换用不带 CSP sandbox 的「信任令牌」—— 页面以 DSH 的源运行，只对信任的文件这样做。
 */
import { useEffect, useState } from 'react'
import type { Translate } from '../context.js'
import { fallbackReader, inlineHtml, type InlineFailure } from '../sidebar/inline-preview.js'
import { askConfirm } from '../sidebar/ContextMenu.js'
import { htmlSandboxByDefault, htmlUnlockKey, isHtmlUnlocked, setHtmlUnlocked } from './prefs.js'
import type { FileIO } from './io.js'

export interface HtmlPreviewProps {
  t: Translate
  io: FileIO
  /** 页面源码（srcdoc 内联模式用）；网页版走预览路由时不需要。 */
  content: string | null
  path: string
  root: string
  /** 强制内联（桌面版）。 */
  inline: boolean
  nonce: number
}

const SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals'

export function HtmlPreview(props: HtmlPreviewProps) {
  const { t, io, content, path, root, inline, nonce } = props
  const key = htmlUnlockKey(io.hostId, path)
  const [unlocked, setUnlocked] = useState(() => isHtmlUnlocked(key))
  const sandboxed = htmlSandboxByDefault() && !unlocked
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [failures, setFailures] = useState<InlineFailure[]>([])
  const [error, setError] = useState<string | null>(null)

  // 网页版：预览路由地址（沙箱与否决定用哪种令牌）。拿不到 → 内联。
  useEffect(() => {
    if (inline) {
      setSrc(null)
      return
    }
    let alive = true
    setSrc(undefined)
    io.previewUrl(path, !sandboxed).then(
      (url) => alive && setSrc(url ?? null),
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      alive = false
    }
  }, [io, path, inline, sandboxed, nonce])

  useEffect(() => {
    setSrcDoc(null)
    if (src !== null || content === null) return
    let alive = true
    const failed: InlineFailure[] = []
    const reader = fallbackReader((p) => io.readData(p), (p) => io.readTextOf(p), failed)
    inlineHtml(content, path, root, reader).then(
      (html) => {
        if (!alive) return
        setSrcDoc(html)
        setFailures(failed)
        if (failed.length > 0) console.warn('[dsh-workspace] 预览资源未能内联', failed)
      },
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      alive = false
    }
  }, [io, src, content, path, root, nonce])

  const unlock = async (): Promise<void> => {
    const ok = await askConfirm({ message: t('viewer.unlockConfirm'), okLabel: t('viewer.unlock'), cancelLabel: t('form.cancel'), danger: true })
    if (!ok) return
    setHtmlUnlocked(key, true)
    setUnlocked(true)
  }
  const relock = (): void => {
    setHtmlUnlocked(key, false)
    setUnlocked(false)
  }

  const name = path.slice(path.lastIndexOf('/') + 1)
  // sandbox 属性：React 对 undefined 不输出属性 = 不沙箱。
  const sandboxAttr = sandboxed ? SANDBOX : undefined
  return (
    <div className="dshws-html-preview">
      {sandboxed ? (
        <div className="dshws-sandbox-bar" data-state="on">
          <span>{t('viewer.sandboxed')}</span>
          <button type="button" className="dshws-link-btn" onClick={() => void unlock()}>
            {t('viewer.unlock')}
          </button>
        </div>
      ) : (
        <div className="dshws-sandbox-bar" data-state="off">
          <span>{unlocked ? t('viewer.unlockedBar') : t('viewer.unsandboxedPref')}</span>
          {unlocked ? (
            <button type="button" className="dshws-link-btn" onClick={relock}>
              {t('viewer.relock')}
            </button>
          ) : null}
        </div>
      )}
      {error !== null ? (
        <div className="dshws-tree-note" data-tone="error">
          {error}
        </div>
      ) : null}
      {failures.length > 0 ? (
        <div className="dshws-tree-note" data-tone="warn" title={failures.map((f) => `${f.path}\n  ${f.message}`).join('\n')}>
          {t('side.inlineMissing', { count: String(failures.length), list: failures.slice(0, 3).map((f) => f.path.slice(f.path.lastIndexOf('/') + 1)).join('、') })}
          {failures.some((f) => /HTTP 404/.test(f.message)) ? ` ${t('side.hostOutdated')}` : ''}
        </div>
      ) : null}
      {typeof src === 'string' ? (
        // 沙箱无 allow-same-origin：预览页是不透明源，碰不到 DSH 界面；样式脚本经预览路由按正确类型返回。
        <iframe key={`${src}|${nonce}`} className="dshws-side-frame" title={name} src={src} sandbox={sandboxAttr} />
      ) : srcDoc !== null ? (
        <iframe key={`${nonce}|${sandboxed}`} className="dshws-side-frame" title={name} srcDoc={srcDoc} sandbox={sandboxAttr} />
      ) : error === null ? (
        <div className="dshws-tree-note">{t('files.loading')}</div>
      ) : null}
    </div>
  )
}
