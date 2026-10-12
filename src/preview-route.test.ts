/*
 * @Description: 远程 HTML 预览路由测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/preview-route.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { Readable } from 'node:stream'
import { PreviewGrants, createPreviewHandler, insideRoot, mimeOf, parsePreviewPath, previewUrl } from './preview-route.js'

const files: Record<string, string> = {
  '/home/ps/app/index.html': '<link rel="stylesheet" href="./style.css">',
  '/home/ps/app/style.css': 'body{color:red}',
  '/home/ps/app/中文/说明.txt': '你好',
  '/etc/passwd': 'root:x:0:0'
}

describe('预览路由', () => {
  let server: Server
  let port: number
  const grants = new PreviewGrants()
  let token: string

  beforeAll(async () => {
    token = grants.grant('h1', '/home/ps/app')
    const handler = createPreviewHandler({
      grants,
      trustedHosts: () => [],
      open: async (hostId, p) => {
        if (hostId !== 'h1' || files[p] === undefined) throw new Error('missing')
        const body = Buffer.from(files[p] as string)
        return { stream: Readable.from([body]), size: body.length }
      }
    })
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => server.close())

  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })

  it('HTML 与同目录样式都可取，样式的 MIME 正确（better-sidebar 加载不出样式的根因之一）', async () => {
    const page = await get(previewUrl(token, '/home/ps/app/index.html'))
    expect(page.status).toBe(200)
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8')
    expect(String(page.headers['content-security-policy'])).toContain('sandbox allow-scripts')
    // 浏览器按页面地址解析 ./style.css：同一令牌、同目录。
    const cssUrl = new URL('./style.css', `http://x${previewUrl(token, '/home/ps/app/index.html')}`).pathname
    const css = await get(cssUrl, { 'Sec-Fetch-Site': 'cross-site' })
    expect(css.status).toBe(200)
    expect(css.headers['content-type']).toBe('text/css; charset=utf-8')
    expect(css.body).toBe('body{color:red}')
  })

  it('中文路径可取', async () => {
    const r = await get(previewUrl(token, '/home/ps/app/中文/说明.txt'))
    expect(r.body).toBe('你好')
  })

  it('【安全】工作区根目录之外（含 .. 与 %2F 绕过）一律 404', async () => {
    expect((await get(`/dsh-workspace/preview/${token}/etc/passwd`)).status).toBe(404)
    expect((await get(`/dsh-workspace/preview/${token}/home/ps/app/../../../etc/passwd`)).status).toBe(404)
    expect((await get(`/dsh-workspace/preview/${token}/home/ps/app/..%2F..%2F..%2Fetc%2Fpasswd`)).status).toBe(404)
    expect((await get(`/dsh-workspace/preview/${token}/home/ps/app2/x`)).status).toBe(404)
  })

  it('【安全】错误令牌 404；外部 Host（DNS 重绑定）403', async () => {
    expect((await get(previewUrl('bogus', '/home/ps/app/index.html'))).status).toBe(404)
    expect((await get(previewUrl(token, '/home/ps/app/index.html'), { Host: 'evil.example' })).status).toBe(403)
  })

  it('信任令牌（临时解除沙箱）：与普通令牌不同，响应不带 CSP sandbox', async () => {
    const trusted = grants.grant('h1', '/home/ps/app', true)
    expect(trusted).not.toBe(token)
    const page = await get(previewUrl(trusted, '/home/ps/app/index.html'))
    expect(page.status).toBe(200)
    expect(String(page.headers['content-security-policy'])).not.toContain('sandbox')
    // 普通令牌仍然沙箱
    expect(String((await get(previewUrl(token, '/home/ps/app/index.html'))).headers['content-security-policy'])).toContain('sandbox')
  })

  it('?probe=1 的主文档注入预览探针（长度、编码正确，仍带 CSP sandbox）；不带参数与相对资源原样返回', async () => {
    files['/home/ps/app/gbk.html'] = '<html><head><title>x</title></head><body>你好</body></html>'
    const page = await get(`${previewUrl(token, '/home/ps/app/gbk.html')}?probe=1`)
    expect(page.status).toBe(200)
    expect(page.body).toContain('<head><script data-dshws-probe>')
    expect(page.body).toContain('<body>你好</body>')
    expect(Number(page.headers['content-length'])).toBe(Buffer.byteLength(page.body))
    expect(String(page.headers['content-security-policy'])).toContain('sandbox allow-scripts')
    const plain = await get(previewUrl(token, '/home/ps/app/gbk.html'))
    expect(plain.body).toBe(files['/home/ps/app/gbk.html'])
    const css = await get(`${previewUrl(token, '/home/ps/app/style.css')}?probe=1`)
    expect(css.body).toBe('body{color:red}')
  })

  it('解除沙箱后同目录 worker.js / 模块脚本可取：MIME 为 JavaScript、不带 CSP sandbox（同源 → new Worker 可用）', async () => {
    files['/home/ps/app/ex/worker.js'] = 'self.onmessage=()=>{}'
    files['/home/ps/app/ex/lib.mjs'] = 'export const x=1'
    const trusted = grants.grant('h1', '/home/ps/app', true)
    // 页面 index.html 里 new Worker('worker.js') 按文档基址解析 = 同令牌同目录
    const workerUrl = new URL('worker.js', `http://x${previewUrl(trusted, '/home/ps/app/ex/index.html')}`).pathname
    const worker = await get(workerUrl)
    expect(worker.status).toBe(200)
    expect(worker.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(worker.headers['x-content-type-options']).toBe('nosniff')
    expect(String(worker.headers['content-security-policy'])).not.toContain('sandbox')
    const mod = await get(previewUrl(trusted, '/home/ps/app/ex/lib.mjs'))
    expect(mod.headers['content-type']).toBe('text/javascript; charset=utf-8')
    expect(mimeOf('a/b.JS')).toBe('text/javascript; charset=utf-8')
    // 信任令牌同样不能逃出根目录
    expect((await get(`/dsh-workspace/preview/${trusted}/home/ps/app/../../../etc/passwd`)).status).toBe(404)
  })

  it('同一主机 + 根目录复用令牌；不同根目录不同令牌', () => {
    expect(grants.grant('h1', '/home/ps/app')).toBe(token)
    expect(grants.grant('h1', '/home/ps/other')).not.toBe(token)
  })

  it('辅助函数', () => {
    expect(mimeOf('a.woff2')).toBe('font/woff2')
    expect(mimeOf('Makefile')).toBe('application/octet-stream')
    expect(insideRoot('/home/ps/app', '/home/ps/app')).toBe(true)
    expect(insideRoot('/home/ps/app', '/home/ps/apple')).toBe(false)
    expect(parsePreviewPath('/dsh-workspace/preview/t/a/%2e%2e/b')?.remotePath).toBe('/b')
  })
})
