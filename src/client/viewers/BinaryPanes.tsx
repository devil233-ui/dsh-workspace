/*
 * @Description: 非文本文件的查看面板 —— file-viewer（PDF / Office / 表格 / 压缩包…）、图片、音视频、仅下载
 * @Author: YangHeng
 * @Date: 2026-10-10 12:10:00
 * @FilePath: /dsh-workspace/src/client/viewers/BinaryPanes.tsx
 *
 * 取数统一走插件的流式下载路由（GET /dsh-workspace/sftp/download，支持 HEAD / Range）：
 * - 音视频、图片直接把地址交给 <video>/<audio>/<img>，浏览器按需发 Range，几 GB 的视频也不进内存；
 * - file-viewer 需要整个文件：fetch 成 Blob → File。路由不可达（旧版宿主）时退回 base64 远程调用（8MB 上限）。
 */
import { useEffect, useRef, useState } from 'react'
import type { Translate } from '../context.js'
import { formatSize } from '../files/transfer.js'
import { needsSizeConfirm, type ViewerPlan } from './dispatch.js'
import { largeFileBytes } from './prefs.js'
import { mount } from './file-viewer.js'
import type { FileIO } from './io.js'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function base64ToBlob(base64: string): Blob {
  const bin = atob(base64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes])
}

/** 取文件大小（HEAD）；拿不到返回 undefined（不阻止加载，只是没法提前提示）。 */
async function headSize(url: string): Promise<number | undefined> {
  try {
    const res = await fetch(url, { method: 'HEAD', credentials: 'same-origin' })
    const len = Number(res.headers.get('content-length') ?? 'NaN')
    return res.ok && Number.isFinite(len) ? len : undefined
  } catch {
    return undefined
  }
}

async function readBlob(io: FileIO): Promise<Blob> {
  try {
    const res = await fetch(io.streamUrl(), { credentials: 'same-origin' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.blob()
  } catch (error) {
    // 下载路由不可达（宿主端还是旧版本 / Web 服务未挂载）：退回远程调用。
    try {
      return base64ToBlob(await io.readData(io.path))
    } catch {
      throw error
    }
  }
}

export function FileViewerPane(props: { t: Translate; io: FileIO; name: string; plan: ViewerPlan; dark: boolean; nonce: number }) {
  const { t, io, name, plan, dark, nonce } = props
  const hostRef = useRef<HTMLDivElement>(null)
  const [phase, setPhase] = useState<'sizing' | 'confirm' | 'loading' | 'ready' | 'error'>('sizing')
  const [size, setSize] = useState<number | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [confirmed, setConfirmed] = useState(false)

  useEffect(() => {
    let alive = true
    setPhase('sizing')
    void headSize(io.streamUrl()).then((s) => {
      if (!alive) return
      setSize(s)
      setPhase(!confirmed && needsSizeConfirm(plan, s, largeFileBytes()) ? 'confirm' : 'loading')
    })
    return () => {
      alive = false
    }
  }, [io, plan, confirmed, nonce])

  // loading → ready 属于同一次挂载：依赖用「是否已放行加载」，避免进入 ready 时清理掉刚挂好的查看器。
  const go = phase === 'loading' || phase === 'ready'
  useEffect(() => {
    if (!go) return
    let alive = true
    let handle: { destroy(): void } | undefined
    void (async () => {
      try {
        const blob = await readBlob(io)
        if (!alive || hostRef.current === null) return
        const h = mount(hostRef.current, { file: new File([blob], name), name, dark })
        handle = h
        await h.ready
        if (alive) setPhase('ready')
      } catch (err) {
        if (alive) {
          setError(messageOf(err))
          setPhase('error')
        }
      }
    })()
    return () => {
      alive = false
      handle?.destroy()
    }
  }, [go, io, name, dark])

  return (
    <div className="dshws-fv">
      {phase === 'sizing' || phase === 'loading' ? <div className="dshws-tree-note">{t('viewer.loading')}</div> : null}
      {phase === 'confirm' ? (
        <div className="dshws-viewer-card">
          <p>{t('viewer.large', { size: formatSize(size ?? 0), limit: formatSize(largeFileBytes()) })}</p>
          <div className="dshws-viewer-actions">
            <button type="button" className="dshws-link-btn" onClick={() => setConfirmed(true)}>
              {t('viewer.loadAnyway')}
            </button>
            <button type="button" className="dshws-link-btn" onClick={() => io.download()}>
              {t('viewer.download')}
            </button>
          </div>
        </div>
      ) : null}
      {phase === 'error' ? (
        <div className="dshws-viewer-card" data-tone="error">
          <p>{t('viewer.loadFailed', { message: error ?? '' })}</p>
          <button type="button" className="dshws-link-btn" onClick={() => io.download()}>
            {t('viewer.download')}
          </button>
        </div>
      ) : null}
      <div className="dshws-fv-host" ref={hostRef} style={{ display: phase === 'ready' || phase === 'loading' ? 'block' : 'none' }} />
    </div>
  )
}

export function MediaPane(props: { t: Translate; io: FileIO; ext: string; nonce: number }) {
  const { t, io, ext, nonce } = props
  const [error, setError] = useState<string | null>(null)
  const audio = /^(mp3|m4a|aac|wav|ogg|oga|opus|flac|weba)$/.test(ext)
  const src = `${io.streamUrl()}&v=${nonce}`
  return (
    <div className="dshws-media">
      {error !== null ? (
        <div className="dshws-tree-note" data-tone="error">
          {t('viewer.mediaError', { message: error })}
        </div>
      ) : null}
      {audio ? (
        <audio controls preload="metadata" src={src} onError={() => setError(t('viewer.mediaUnsupported'))} />
      ) : (
        <video controls preload="metadata" src={src} onError={() => setError(t('viewer.mediaUnsupported'))} />
      )}
    </div>
  )
}

export function ImagePane(props: { t: Translate; io: FileIO; name: string; nonce: number }) {
  const { t, io, name, nonce } = props
  const [natural, setNatural] = useState(false)
  const [error, setError] = useState(false)
  return (
    <div className="dshws-side-image" data-natural={natural}>
      {error ? (
        <div className="dshws-viewer-card" data-tone="error">
          <p>{t('viewer.loadFailed', { message: name })}</p>
        </div>
      ) : (
        <img src={`${io.streamUrl()}&v=${nonce}`} alt={name} title={t('viewer.imageToggle')} onClick={() => setNatural(!natural)} onError={() => setError(true)} />
      )}
    </div>
  )
}

export function DownloadPane(props: { t: Translate; io: FileIO; reason: 'format' | 'binary' }) {
  const { t, io, reason } = props
  return (
    <div className="dshws-viewer-card">
      <p>{reason === 'format' ? t('viewer.downloadOnly') : t('viewer.binary')}</p>
      <button type="button" className="dshws-link-btn" onClick={() => io.download()}>
        {t('viewer.download')}
      </button>
    </div>
  )
}
