/*
 * @Description: 静态资源路由与 UTF-8 判定测试
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/assets-route.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { gzipSync } from 'node:zlib'
import { ASSETS_PREFIX, createAssetsHandler, viewerAsset } from './assets-route.js'
import { utf8RoundTrips } from './sftp/remote-fs.js'

describe('静态资源路由', () => {
  let dir: string
  let server: Server
  let port: number

  beforeAll(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'dshws-assets-'))
    writeFileSync(path.join(dir, 'monaco.js'), 'console.log("monaco")')
    writeFileSync(path.join(dir, 'monaco.js.gz'), gzipSync('console.log("monaco")'))
    writeFileSync(path.join(dir, 'editor.worker.js'), 'self.x=1')
    writeFileSync(path.join(dir, 'secret.txt'), 'nope')
    const handler = createAssetsHandler(dir, () => [])
    server = createServer((req, res) => void handler(req, res))
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    port = (server.address() as AddressInfo).port
  })
  afterAll(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const get = (p: string, headers: Record<string, string> = {}) =>
    new Promise<{ status: number; headers: Record<string, unknown>; body: string }>((resolve, reject) => {
      const req = request({ host: '127.0.0.1', port, path: p, agent: false, headers: { Host: `127.0.0.1:${port}`, ...headers } }, (res) => {
        let body = ''
        res.setEncoding('latin1')
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body }))
      })
      req.on('error', reject)
      req.end()
    })

  it('白名单文件可取，类型正确', async () => {
    const r = await get(`${ASSETS_PREFIX}/editor.worker.js`)
    expect(r.status).toBe(200)
    expect(r.headers['content-type']).toContain('text/javascript')
    expect(r.body).toBe('self.x=1')
  })

  it('支持 gzip 时发预压缩版本', async () => {
    const r = await get(`${ASSETS_PREFIX}/monaco.js`, { 'Accept-Encoding': 'gzip, deflate' })
    expect(r.headers['content-encoding']).toBe('gzip')
    const plain = await get(`${ASSETS_PREFIX}/monaco.js`)
    expect(plain.headers['content-encoding']).toBeUndefined()
    expect(plain.body).toBe('console.log("monaco")')
  })

  it('ETag 命中返回 304', async () => {
    const first = await get(`${ASSETS_PREFIX}/monaco.js`)
    const again = await get(`${ASSETS_PREFIX}/monaco.js`, { 'If-None-Match': String(first.headers.etag) })
    expect(again.status).toBe(304)
  })

  it('【安全】非白名单文件与目录穿越一律 404', async () => {
    for (const p of ['secret.txt', '../package.json', '..%2Fpackage.json', 'monaco.js.gz', '']) {
      expect((await get(`${ASSETS_PREFIX}/${p}`)).status, p).toBe(404)
    }
  })

  it('查看器资源子树：按扩展名给类型，可多级目录', async () => {
    mkdirSync(path.join(dir, 'viewers', 'fv', 'vendor', 'pdf'), { recursive: true })
    writeFileSync(path.join(dir, 'viewers', 'file-viewer.js'), 'export {}')
    writeFileSync(path.join(dir, 'viewers', 'fv', 'vendor', 'pdf', 'x.wasm'), 'w')
    writeFileSync(path.join(dir, 'viewers', 'notes.txt'), 'nope')
    const js = await get(`${ASSETS_PREFIX}/viewers/file-viewer.js?v=1`)
    expect(js.status).toBe(200)
    expect(js.headers['content-type']).toContain('text/javascript')
    expect((await get(`${ASSETS_PREFIX}/viewers/fv/vendor/pdf/x.wasm`)).headers['content-type']).toBe('application/wasm')
  })

  it('【安全】查看器子树：未知扩展名、目录、穿越一律 404', async () => {
    for (const p of ['viewers/notes.txt', 'viewers/fv', 'viewers/../secret.txt', 'viewers/..%2F..%2Fsecret.txt', 'viewers//file-viewer.js', 'viewers/a%5Cb.js']) {
      expect((await get(`${ASSETS_PREFIX}/${p}`)).status, p).toBe(404)
    }
    // 直接调用（不经 URL 规范化）：编码过的 .. 与分隔符同样被拒。
    expect(viewerAsset(dir, 'viewers/../../etc/passwd.js')).toBeUndefined()
    expect(viewerAsset(dir, 'viewers/fv/%2E%2E/%2E%2E/x.js')).toBeUndefined()
    expect(viewerAsset(dir, 'viewers/a%2F..%2F..%2Fx.js')).toBeUndefined()
  })

  it('【安全】跨站请求被围栏拒绝', async () => {
    expect((await get(`${ASSETS_PREFIX}/monaco.js`, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
  })
})

describe('utf8RoundTrips', () => {
  it('合法 UTF-8（含中文）判为可安全编辑', () => {
    expect(utf8RoundTrips(Buffer.from('你好 world\n'), false)).toBe(true)
  })

  it('GBK 编码的中文判为有损', () => {
    // 「中文」的 GBK 编码
    expect(utf8RoundTrips(Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), false)).toBe(false)
  })

  it('截断在多字节字符中间不误判', () => {
    const full = Buffer.from('abc中文')
    expect(utf8RoundTrips(full.subarray(0, full.length - 1), true)).toBe(true)
  })

  it('截断前的内容本身非法仍能识别', () => {
    const bad = Buffer.concat([Buffer.from([0xd6, 0xd0, 0xce, 0xc4]), Buffer.from('xxxxxx')])
    expect(utf8RoundTrips(bad, true)).toBe(false)
  })
})
