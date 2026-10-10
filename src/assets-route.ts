/*
 * @Description: 静态资源路由 —— 提供按需加载的 Monaco 编辑器脚本
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/assets-route.ts
 *
 *   GET /dsh-workspace/assets/<白名单文件>
 *
 *   GET /dsh-workspace/assets/viewers/<子路径>   文件查看器（file-viewer / Markdown 增强）的按需分片与运行时资源
 *
 * 只认白名单里的文件名，不拼接任意路径，天然没有目录穿越；viewers 子树按扩展名放行并逐段校验（见 viewerAsset）。
 * 带 ETag，浏览器缓存后重复打开只有一次 304；客户端支持 gzip 时发预压缩的 .gz。
 */
import { createReadStream, existsSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import path from 'node:path'
import { isTrustedRequest } from './terminal/trust-fence.js'

/** 不带结尾斜杠，原因见 contract.ts 的 SFTP_HTTP_PREFIX。 */
export const ASSETS_PREFIX = '/dsh-workspace/assets'

const ALLOWED: Record<string, string> = {
  'monaco.js': 'text/javascript; charset=utf-8',
  'editor.worker.js': 'text/javascript; charset=utf-8'
}

/** 查看器资源（lib/assets/viewers/**，见 scripts/build-viewers.mjs）按扩展名给类型；不在表里的扩展名一律 404。 */
const VIEWER_TYPES: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  css: 'text/css; charset=utf-8',
  wasm: 'application/wasm',
  bcmap: 'application/octet-stream',
  pfb: 'application/octet-stream',
  ttf: 'font/ttf',
  otf: 'font/otf',
  woff: 'font/woff',
  woff2: 'font/woff2'
}

/**
 * 查看器资源子树：file-viewer 的 Worker / WASM / cMap / 字体与按需分片数量多、名字带哈希，不适合逐个白名单，
 * 所以按「目录 + 扩展名」放行。逐段校验（不允许空段、.、..、反斜杠、NUL，解码后不得含 /），
 * 拼出的路径再确认仍在 viewers 目录下 —— 与白名单同样没有目录穿越。
 */
export function viewerAsset(assetsDir: string, name: string): { file: string; type: string } | undefined {
  if (!name.startsWith('viewers/')) return undefined
  let segments: string[]
  try {
    segments = name.slice('viewers/'.length).split('/').map((s) => decodeURIComponent(s))
  } catch {
    return undefined
  }
  if (segments.length === 0 || segments.some((s) => s === '' || s === '.' || s === '..' || /[\\/\0:]/.test(s))) return undefined
  const ext = (segments[segments.length - 1] as string).split('.').pop()?.toLowerCase() ?? ''
  const type = Object.hasOwn(VIEWER_TYPES, ext) ? VIEWER_TYPES[ext] : undefined
  if (type === undefined) return undefined
  const base = path.join(assetsDir, 'viewers')
  const file = path.join(base, ...segments)
  if (!file.startsWith(base + path.sep)) return undefined
  return { file, type }
}

export function createAssetsHandler(assetsDir: string, trustedHosts: () => readonly string[]) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isTrustedRequest(req as never, trustedHosts())) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const name = new URL(req.url ?? '/', 'http://x').pathname.slice(ASSETS_PREFIX.length + 1)
    const viewer = viewerAsset(assetsDir, name)
    const type = viewer?.type ?? (Object.hasOwn(ALLOWED, name) ? ALLOWED[name] : undefined)
    const file = viewer?.file ?? path.join(assetsDir, name)
    if (type === undefined || !existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404).end()
      return
    }

    const gzFile = `${file}.gz`
    const acceptsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] ?? ''))
    const useGz = acceptsGzip && existsSync(gzFile)
    const served = useGz ? gzFile : file
    const stat = statSync(served)
    const etag = `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}${useGz ? '-gz' : ''}"`

    const headers: Record<string, string | number> = {
      'Content-Type': type,
      ETag: etag,
      // 每次都向服务端确认（命中就是 304），插件升级后不会拿到旧脚本。
      'Cache-Control': 'no-cache',
      Vary: 'Accept-Encoding',
      'X-Content-Type-Options': 'nosniff'
    }
    if (req.headers['if-none-match'] === etag) {
      res.writeHead(304, headers).end()
      return
    }
    headers['Content-Length'] = stat.size
    if (useGz) headers['Content-Encoding'] = 'gzip'
    res.writeHead(200, headers)
    if (req.method === 'HEAD') {
      res.end()
      return
    }
    const stream = createReadStream(served)
    stream.on('error', () => res.destroy())
    stream.pipe(res)
  }
}
