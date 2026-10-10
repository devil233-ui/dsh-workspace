/*
 * @Description: SFTP 上传 / 下载的 HTTP 流式路由（与终端同一道信任围栏）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/sftp/http.ts
 *
 * 为什么不走 Typert：Typert 调用是 JSON，二进制要 base64（体积 +33%）且整包进内存。
 * 这里请求体 / 响应体直接与 SFTP 流对接，几 GB 的文件也只占常量内存。
 *
 *   GET  /dsh-workspace/sftp/download?host=<id>&path=<远端路径>[&inline=1]
 *        支持 HEAD 与单区间 Range（206）；inline=1 时图片 / 音视频 / PDF 按真实类型内联返回（查看器用）。
 *        host=local:* 为本机任意路径只读（见 local-fs.ts 的 resolveReadablePath）。
 *   POST /dsh-workspace/sftp/upload?host=<id>&dir=<远端目录>&name=<文件名>&overwrite=0|1
 *        请求体 = 文件原始字节
 */
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Transform } from 'node:stream'
import { isTrustedRequest } from '../terminal/trust-fence.js'
import { VaultLockedError, VaultUninitializedError } from '../vault/store.js'
import { ERROR_CODES, SFTP_HTTP_PREFIX } from '../wire/contract.js'
import type { WorkspaceRuntime } from '../runtime.js'
import { RemoteExistsError, type RemoteFs } from './remote-fs.js'
import { LOCAL_ANY_ID, isLocalId, localReader, type LocalFs } from '../local/local-fs.js'

export { SFTP_HTTP_PREFIX }

export interface SftpHttpDeps {
  rt: WorkspaceRuntime
  fs: RemoteFs
  /** 本地工作区（host=local:<sessionId>）。 */
  localFs?: LocalFs
  trustedHosts: () => readonly string[]
  maxUploadBytes: number
}

/** 以 JSON 返回错误；code 与 Typert 错误码一致，浏览器可复用同一套分支。 */
function fail(res: ServerResponse, status: number, code: string, message: string): void {
  if (res.headersSent) {
    res.destroy()
    return
  }
  const body = JSON.stringify({ code, message })
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  })
  res.end(body)
}

function mapError(res: ServerResponse, error: unknown): void {
  if (error instanceof VaultLockedError) return fail(res, 423, ERROR_CODES.vaultLocked, error.message)
  if (error instanceof VaultUninitializedError) return fail(res, 423, ERROR_CODES.vaultUninitialized, error.message)
  if (error instanceof RemoteExistsError) return fail(res, 409, ERROR_CODES.exists, error.message)
  if (error instanceof UploadTooLargeError) return fail(res, 413, 'dsh-workspace/too-large', error.message)
  const message = error instanceof Error ? error.message : String(error)
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  const notFound = code === 2 || code === 'ENOENT'
  return fail(res, notFound ? 404 : 400, notFound ? ERROR_CODES.notFound : ERROR_CODES.failed, message)
}

/**
 * RFC 6266 / 5987：中文文件名需要 filename*=UTF-8''<百分号编码>；
 * 同时给一个 ASCII 的 filename 兜底老客户端。
 */
export function contentDisposition(name: string): string {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_')
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

class UploadTooLargeError extends Error {
  constructor(limit: number) {
    super(`上传文件超过上限（${Math.round(limit / 1024 / 1024)} MB）。`)
    this.name = 'UploadTooLargeError'
  }
}

/** 计数流：超过上限立即报错，终止上传（临时文件由 upload() 清理）。 */
function limitBytes(limit: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length
      if (seen > limit) callback(new UploadTooLargeError(limit))
      else callback(null, chunk)
    }
  })
}

/**
 * 解析 Range 请求头（只支持单区间：bytes=a-b / bytes=a- / bytes=-n）。
 * 返回 undefined = 没有或不认识（按整文件 200 返回，RFC 允许忽略 Range）；'invalid' = 区间越界（416）。
 */
export function parseRange(header: string | undefined, size: number): { start: number; end: number } | 'invalid' | undefined {
  if (header === undefined) return undefined
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (m === null || (m[1] === '' && m[2] === '')) return undefined
  if (m[1] === '') {
    // 后缀区间：最后 n 字节
    const n = Number(m[2])
    if (n === 0 || size === 0) return 'invalid'
    return { start: Math.max(0, size - n), end: size - 1 }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1)
  if (start >= size || end < start) return 'invalid'
  return { start, end }
}

/**
 * inline=1 时允许按真实类型内联显示的 MIME（图片 / 音视频 / PDF）。
 * 其余一律 application/octet-stream + attachment：同源下载路由若按 text/html、image/svg+xml 内联返回，
 * 文件里的脚本就会以 DSH 页面的源执行 —— 这是必须守住的边界。
 */
const INLINE_MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  bmp: 'image/bmp', ico: 'image/x-icon',
  mp4: 'video/mp4', m4v: 'video/mp4', webm: 'video/webm', ogv: 'video/ogg', mov: 'video/quicktime',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac', weba: 'audio/webm',
  pdf: 'application/pdf'
}

export function inlineMimeOf(name: string): string | undefined {
  const dot = name.lastIndexOf('.')
  return dot === -1 ? undefined : INLINE_MIME[name.slice(dot + 1).toLowerCase()]
}

/** 路由处理器。返回的函数直接交给 webServer.register({ kind: 'prefix' })。 */
export function createSftpHttpHandler(deps: SftpHttpDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 与 /api 网关、终端 socket 同一道围栏：挡住 DNS 重绑定与跨站请求。
    // 下载走 GET，恶意页面用 <a>/<img> 触发时浏览器会带 sec-fetch-site: cross-site，在此被拒。
    if (!isTrustedRequest(req as never, deps.trustedHosts())) {
      deps.rt.log.warn(
        '',
        'sftp',
        '拒绝了一次不受信任的文件传输请求。',
        `host=${String(req.headers.host ?? '')} origin=${String(req.headers.origin ?? '')} sec-fetch-site=${String(req.headers['sec-fetch-site'] ?? '')}`
      )
      return fail(res, 403, 'dsh-workspace/forbidden', 'forbidden')
    }

    // 桌面版的页面来源可以不是宿主服务（端口不同 = 跨源）：上传 XHR 需要 CORS 头才能读到结果。
    // 只回显「已通过上面信任围栏」的请求的 Origin（围栏已要求 Origin 与 Host 同为本机回环或同一主机名），不用 *。
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : undefined
    if (origin !== undefined && origin !== 'null') {
      res.setHeader('Access-Control-Allow-Origin', origin)
      res.setHeader('Vary', 'Origin')
    }
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Methods': 'GET, HEAD, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Range',
        'Access-Control-Max-Age': '600',
        'Cache-Control': 'no-store'
      })
      res.end()
      return
    }

    const url = new URL(req.url ?? '/', 'http://x')
    const action = url.pathname.slice(SFTP_HTTP_PREFIX.length + 1)
    const hostId = url.searchParams.get('host') ?? ''
    // local:* = 本机任意路径只读（查看器打开工作区外的文件用），只允许下载。
    const anyLocal = hostId === LOCAL_ANY_ID
    const local = isLocalId(hostId) && deps.localFs !== undefined
    if (!local && (hostId === '' || deps.rt.vault.getHost(hostId) === undefined)) {
      return fail(res, 404, ERROR_CODES.notFound, '主机不存在。')
    }
    // 本地工作区与远程主机同一套接口；本地的根目录限制在 LocalFs 内强制。
    const fs: Pick<RemoteFs, 'openDownload' | 'upload'> = local ? (deps.localFs as LocalFs) : deps.fs

    if (action === 'download' && (req.method === 'GET' || req.method === 'HEAD')) {
      try {
        const filePath = url.searchParams.get('path') ?? ''
        const inline = url.searchParams.get('inline') === '1'
        let invalidRange = false
        // Range：音视频拖动进度、PDF 分段都靠它；区间在拿到文件大小后才能确定。
        const pickRange = (size: number): { start: number; end: number } | undefined => {
          const r = parseRange(typeof req.headers.range === 'string' ? req.headers.range : undefined, size)
          if (r === 'invalid') {
            invalidRange = true
            return undefined
          }
          return r
        }
        const opened = anyLocal ? await localReader.openDownload(filePath, pickRange) : await fs.openDownload(hostId, filePath, pickRange)
        const { stream, size, name, range } = opened
        if (invalidRange) {
          stream.destroy()
          res.writeHead(416, { 'Content-Range': `bytes */${size}`, 'Cache-Control': 'no-store' }).end()
          return
        }
        const mime = inline ? inlineMimeOf(name) : undefined
        const headers: Record<string, string | number> = {
          'Content-Type': mime ?? 'application/octet-stream',
          'Content-Length': range === undefined ? size : range.end - range.start + 1,
          'Content-Disposition': mime !== undefined ? 'inline' : contentDisposition(name),
          'Accept-Ranges': 'bytes',
          // no-transform：确保压缩中间件不改写响应，Content-Length 始终准确。
          'Cache-Control': 'no-store, no-transform',
          'X-Content-Type-Options': 'nosniff'
        }
        // 内联响应再加一道沙箱：即便被当成顶层页面打开，也处在不透明源里。
        if (mime !== undefined) headers['Content-Security-Policy'] = "sandbox; default-src 'none'; img-src 'self' data:; media-src 'self'; object-src 'none'"
        if (range !== undefined) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${size}`
        res.writeHead(range === undefined ? 200 : 206, headers)
        if (req.method === 'HEAD') {
          stream.destroy()
          res.end()
          return
        }
        stream.on('error', (error) => {
          deps.rt.log.error(hostId, 'sftp', `下载中断：${name}`, error)
          res.destroy(error)
        })
        // 浏览器取消下载（或播放器跳到别处重新请求区间）时关闭读取流，不让 SFTP 继续空转。
        res.on('close', () => stream.destroy())
        stream.pipe(res)
      } catch (error) {
        deps.rt.log.error(hostId, 'sftp', '下载失败。', error)
        mapError(res, error)
      }
      return
    }
    if (anyLocal) return fail(res, 405, 'dsh-workspace/bad-request', 'read-only')


    if (action === 'upload' && req.method === 'POST') {
      try {
        const declared = Number(req.headers['content-length'] ?? 'NaN')
        if (Number.isFinite(declared) && declared > deps.maxUploadBytes) {
          throw new UploadTooLargeError(deps.maxUploadBytes)
        }
        const result = await fs.upload(
          hostId,
          url.searchParams.get('dir') ?? '',
          url.searchParams.get('name') ?? '',
          req.pipe(limitBytes(deps.maxUploadBytes)),
          { overwrite: url.searchParams.get('overwrite') === '1' }
        )
        const body = JSON.stringify({ ok: true, path: result.path })
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
        res.end(body)
      } catch (error) {
        deps.rt.log.error(hostId, 'sftp', '上传失败。', error)
        // 请求体可能还没读完；排空后再回响应，避免客户端收到连接重置而看不到错误原因。
        req.resume()
        mapError(res, error)
      }
      return
    }

    fail(res, 405, 'dsh-workspace/bad-request', 'unsupported method or action')
  }
}
