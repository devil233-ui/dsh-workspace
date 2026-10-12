/*
 * @Description: 远程 HTML 预览路由 —— 经 SFTP 读取远程文件，相对资源（./style.css）自动可用
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/preview-route.ts
 *
 *   GET /dsh-workspace/preview/<令牌>/<逐段编码的远程绝对路径>
 *
 * 为什么用路径里的令牌、而不是靠请求来源判断：预览页在沙箱 iframe 里（不同源），它发出的
 * 样式 / 脚本请求在浏览器看来是跨站（Sec-Fetch-Site: cross-site），按来源判断会把自己的样式挡掉
 * （better-sidebar 的 HTML 预览加载不出样式，这是原因之一）。
 * 令牌由已认证的远程调用签发，只绑定「一台主机 + 一个远程工作区根目录」，页面里的相对路径
 * 自然带着同一个令牌；外部网页猜不到令牌，也就读不到任何文件。宿主名校验（防 DNS 重绑定）照常保留。
 *
 * 所有响应带 CSP sandbox（无 allow-same-origin）：即便有人把预览地址当顶层页面打开，
 * 它也处在不透明源里，碰不到 DSH 界面的接口与会话。
 */
import { randomBytes } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { posix } from 'node:path'
import type { Readable } from 'node:stream'
import { isTrustedRequest } from './terminal/trust-fence.js'
import { withPreviewProbe } from './wire/preview-probe.js'

/** 不带结尾斜杠（宿主前缀匹配规则见 contract.ts 的 SFTP_HTTP_PREFIX）。 */
export const PREVIEW_PREFIX = '/dsh-workspace/preview'

/** 预览单文件上限。 */
const MAX_PREVIEW_BYTES = 64 * 1024 * 1024

const MIME: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  css: 'text/css; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  xml: 'application/xml; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  eot: 'application/vnd.ms-fontobject',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  wasm: 'application/wasm',
  pdf: 'application/pdf'
}

export function mimeOf(file: string): string {
  const dot = file.lastIndexOf('.')
  const ext = dot === -1 ? '' : file.slice(dot + 1).toLowerCase()
  return MIME[ext] ?? 'application/octet-stream'
}

interface Grant {
  hostId: string
  /** 允许访问的远程根目录（工作区根）。 */
  root: string
  /**
   * 用户在查看器里「临时解除沙箱」时签发的令牌：响应不带 CSP sandbox，页面以 DSH 的源运行。
   * 与普通令牌分开签发：沙箱里的页面只知道自己的普通令牌（就在它的 URL 里），无法据此拿到不沙箱的版本。
   */
  trusted: boolean
}

/** 令牌表：进程内存里，插件重载即全部失效。同一主机 + 根目录（+ 是否信任）复用同一个令牌。 */
export class PreviewGrants {
  private byToken = new Map<string, Grant>()

  grant(hostId: string, root: string, trusted = false): string {
    for (const [token, g] of this.byToken) if (g.hostId === hostId && g.root === root && g.trusted === trusted) return token
    const token = randomBytes(18).toString('base64url')
    this.byToken.set(token, { hostId, root, trusted })
    return token
  }

  get(token: string): Grant | undefined {
    return this.byToken.get(token)
  }

  clear(): void {
    this.byToken.clear()
  }
}

/** 远程路径 → 预览地址（逐段编码，保持相对资源可解析）。 */
export function previewUrl(token: string, remotePath: string): string {
  return `${PREVIEW_PREFIX}/${token}${remotePath.split('/').map((s) => encodeURIComponent(s)).join('/')}`
}

/** 解析请求路径；非法返回 undefined。 */
export function parsePreviewPath(pathname: string): { token: string; remotePath: string } | undefined {
  if (!pathname.startsWith(`${PREVIEW_PREFIX}/`)) return undefined
  const rest = pathname.slice(PREVIEW_PREFIX.length + 1)
  const slash = rest.indexOf('/')
  if (slash <= 0) return undefined
  const token = rest.slice(0, slash)
  let segments: string[]
  try {
    segments = rest.slice(slash + 1).split('/').map((s) => decodeURIComponent(s))
  } catch {
    return undefined
  }
  // 解码后不允许出现路径分隔符或 NUL（防止 %2F 之类绕过逐段校验）。
  if (segments.some((s) => s.includes('/') || s.includes('\0'))) return undefined
  const remotePath = posix.normalize(`/${segments.join('/')}`)
  return { token, remotePath }
}

/** 远程路径是否在根目录内（折叠 .. 之后判断）。 */
export function insideRoot(root: string, remotePath: string): boolean {
  const r = root.replace(/\/+$/, '') || '/'
  return r === '/' || remotePath === r || remotePath.startsWith(`${r}/`)
}

export interface PreviewDeps {
  grants: PreviewGrants
  trustedHosts: () => readonly string[]
  /** 打开远程文件读取流（只允许普通文件）。 */
  open(hostId: string, remotePath: string): Promise<{ stream: Readable; size: number }>
}

export function createPreviewHandler(deps: PreviewDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    // 只校验宿主名（防 DNS 重绑定），不校验来源：见文件头说明。
    if (!isTrustedRequest({ headers: { host: req.headers.host } } as never, deps.trustedHosts())) {
      res.writeHead(403).end()
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405).end()
      return
    }
    const parsed = parsePreviewPath(new URL(req.url ?? '/', 'http://x').pathname)
    const grant = parsed === undefined ? undefined : deps.grants.get(parsed.token)
    if (parsed === undefined || grant === undefined || !insideRoot(grant.root, parsed.remotePath)) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    let opened: { stream: Readable; size: number }
    try {
      opened = await deps.open(grant.hostId, parsed.remotePath)
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    if (opened.size > MAX_PREVIEW_BYTES) {
      opened.stream.destroy()
      res.writeHead(413).end()
      return
    }
    const type = mimeOf(parsed.remotePath)
    // ?probe=1（查看器加载的主文档）：注入预览探针，页面报错 / 空白时查看器能提示原因（见 wire/preview-probe.ts）。
    // 按 latin1 在原始字节里插入纯 ASCII 脚本，不改动页面自身的编码；相对资源请求不带该参数，原样返回。
    let body: Buffer | undefined
    if (type.startsWith('text/html') && req.method === 'GET' && new URL(req.url ?? '/', 'http://x').searchParams.get('probe') === '1') {
      try {
        const raw = await readAll(opened.stream)
        body = Buffer.from(withPreviewProbe(raw.toString('latin1')), 'latin1')
      } catch {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('not found')
        return
      }
    }
    res.writeHead(200, {
      'Content-Type': type,
      'Content-Length': body?.length ?? opened.size,
      'Cache-Control': 'no-cache',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': grant.trusted
        ? "object-src 'none'"
        : "sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads; object-src 'none'"
    })
    if (body !== undefined) {
      res.end(body)
      return
    }
    if (req.method === 'HEAD') {
      opened.stream.destroy()
      res.end()
      return
    }
    opened.stream.on('error', () => res.destroy())
    opened.stream.pipe(res)
  }
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  return Buffer.concat(chunks)
}
