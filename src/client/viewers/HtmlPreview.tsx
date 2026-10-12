/*
 * @Description: HTML / SVG 预览 —— 默认沙箱，可「临时解除沙箱」（本次页面会话对该文件有效）
 * @Author: YangHeng
 * @Date: 2026-10-10 12:10:00
 * @FilePath: /dsh-workspace/src/client/viewers/HtmlPreview.tsx
 *
 * 加载方式见 html-frame.ts 的 frameLoadMode：http(s) 页面（含 Windows 桌面版兼容模式）iframe 直接加载预览路由
 * （令牌鉴权，文档基址 = 文件所在目录，Worker / fetch / 模块导入等运行时相对地址都按文件位置解析）；
 * 非 http(s) 页面、桌面版沙箱、没有预览路由（工作区外的本机文件）改为 srcdoc + 相对资源内联（见 sidebar/inline-preview.ts），
 * 能拿到预览路由时再注入 <base href> 指向文件目录（尽力而为）。
 * 沙箱：默认 allow-scripts 但无 allow-same-origin（脚本可运行，但处在不透明源，碰不到 DSH 界面与接口）。
 * 解除沙箱 = iframe 不带 sandbox、预览路由换用不带 CSP sandbox 的「信任令牌」—— 页面以 DSH 的源运行，只对信任的文件这样做。
 *
 * 诊断：.html 页面注入预览探针（wire/preview-probe.ts），页面报错、资源缺失、空白或迟迟没加载完时在提示条下方说明原因，
 * 而不是只留一片白。
 */
import { useEffect, useRef, useState } from 'react'
import type { Translate } from '../context.js'
import { fallbackReader, inlineHtml, type InlineFailure } from '../sidebar/inline-preview.js'
import { askConfirm } from '../sidebar/ContextMenu.js'
import { readProbeMessage, withPreviewProbe } from '../../wire/preview-probe.js'
import {
  EMPTY_PROBE,
  PROBE_TIMEOUT_MS,
  frameLoadMode,
  framePlan,
  previewBaseHref,
  probeNotes,
  reduceProbe,
  shouldProbe,
  withBaseHref,
  withProbeQuery,
  type ProbeState
} from './html-frame.js'
import { htmlSandboxByDefault, htmlUnlockKey, isHtmlUnlocked, setHtmlUnlocked } from './prefs.js'
import type { FileIO } from './io.js'

export interface HtmlPreviewProps {
  t: Translate
  io: FileIO
  /** 页面源码（srcdoc 内联模式用）；网页版走预览路由时不需要。 */
  content: string | null
  path: string
  root: string
  /** 运行在 DSH 桌面版渲染进程里（决定沙箱预览能否直接请求预览路由，见 frameLoadMode）。 */
  desktop: boolean
  nonce: number
}

export function HtmlPreview(props: HtmlPreviewProps) {
  const { t, io, content, path, root, desktop, nonce } = props
  const key = htmlUnlockKey(io.hostId, path)
  const [unlocked, setUnlocked] = useState(() => isHtmlUnlocked(key))
  const sandboxed = htmlSandboxByDefault() && !unlocked
  const probing = shouldProbe(path, content)
  const load = frameLoadMode({ protocol: location.protocol, desktop, sandboxed })
  const [src, setSrc] = useState<string | null | undefined>(undefined)
  const [baseHref, setBaseHref] = useState<string | undefined>(undefined)
  const [srcDoc, setSrcDoc] = useState<string | null>(null)
  const [failures, setFailures] = useState<InlineFailure[]>([])
  const [error, setError] = useState<string | null>(null)
  const [probe, setProbe] = useState<ProbeState>(EMPTY_PROBE)
  const [timedOut, setTimedOut] = useState(false)
  const frameRef = useRef<HTMLIFrameElement>(null)

  // 预览路由地址（沙箱与否决定用哪种令牌）。src 模式直接加载；srcdoc 模式只拿来做 <base>。拿不到（工作区外的本机文件）→ 内联、无 <base>。
  useEffect(() => {
    let alive = true
    setSrc(undefined)
    setBaseHref(undefined)
    io.previewUrl(path, !sandboxed).then(
      (url) => {
        if (!alive) return
        if (url !== undefined && load === 'src') {
          setSrc(probing ? withProbeQuery(url) : url)
          return
        }
        setBaseHref(url === undefined ? undefined : previewBaseHref(url, location.href))
        setSrc(null)
      },
      (err: unknown) => {
        if (!alive) return
        // srcdoc 模式下预览路由只是锦上添花（<base>），签发失败照常内联预览，不当成错误。
        if (load === 'srcdoc') setSrc(null)
        else setError(err instanceof Error ? err.message : String(err))
      }
    )
    return () => {
      alive = false
    }
  }, [io, path, load, sandboxed, nonce, probing])

  useEffect(() => {
    setSrcDoc(null)
    if (src !== null || content === null) return
    let alive = true
    const failed: InlineFailure[] = []
    const reader = fallbackReader((p) => io.readData(p), (p) => io.readTextOf(p), failed)
    inlineHtml(content, path, root, reader).then(
      (inlined) => {
        if (!alive) return
        const html = baseHref !== undefined ? withBaseHref(inlined, baseHref) : inlined
        setSrcDoc(probing ? withPreviewProbe(html) : html)
        setFailures(failed)
        if (failed.length > 0) console.warn('[dsh-workspace] 预览资源未能内联', failed)
      },
      (err: unknown) => alive && setError(err instanceof Error ? err.message : String(err))
    )
    return () => {
      alive = false
    }
  }, [io, src, baseHref, content, path, root, nonce, probing])

  const plan = framePlan({ src, srcDoc, sandboxed, nonce })
  const frameKey = plan?.key

  // 探针：每换一次浏览上下文重新计；只收自己这个 iframe 发来的消息（同一页面可能开着多个预览）。
  useEffect(() => {
    setProbe(EMPTY_PROBE)
    setTimedOut(false)
    if (frameKey === undefined || !probing) return
    const onMessage = (e: MessageEvent): void => {
      if (e.source === null || e.source !== frameRef.current?.contentWindow) return
      const msg = readProbeMessage(e.data)
      if (msg !== undefined) setProbe((s) => reduceProbe(s, msg))
    }
    window.addEventListener('message', onMessage)
    const timer = setTimeout(() => setTimedOut(true), PROBE_TIMEOUT_MS)
    return () => {
      window.removeEventListener('message', onMessage)
      clearTimeout(timer)
    }
  }, [frameKey, probing])

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
  const missing = [...failures.map((f) => f.path), ...probe.resources]
  const baseName = (p: string) => p.replace(/[?#].*$/, '').slice(p.replace(/[?#].*$/, '').lastIndexOf('/') + 1) || p
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
      {missing.length > 0 ? (
        <div
          className="dshws-tree-note"
          data-tone="warn"
          title={[...failures.map((f) => `${f.path}\n  ${f.message}`), ...probe.resources].join('\n')}
        >
          {t('side.inlineMissing', { count: String(missing.length), list: missing.slice(0, 3).map(baseName).join('、') })}
          {failures.some((f) => /HTTP 404/.test(f.message)) ? ` ${t('side.hostOutdated')}` : ''}
        </div>
      ) : null}
      {probeNotes(probe, { sandboxed, timedOut, timeoutSeconds: PROBE_TIMEOUT_MS / 1000 }).map((n) => (
        <div key={n.key} className="dshws-tree-note" data-tone={n.tone} title={n.title}>
          {t(n.key, n.vars)}
          {n.hint !== undefined ? t(n.hint) : ''}
        </div>
      ))}
      {plan !== undefined ? (
        // 沙箱无 allow-same-origin：预览页是不透明源，碰不到 DSH 界面；样式脚本经预览路由按正确类型返回。
        <iframe
          key={plan.key}
          ref={frameRef}
          className="dshws-side-frame"
          title={name}
          {...(plan.src !== undefined ? { src: plan.src } : { srcDoc: plan.srcDoc })}
          sandbox={plan.sandbox}
        />
      ) : error === null ? (
        <div className="dshws-tree-note">{t('files.loading')}</div>
      ) : null}
    </div>
  )
}
