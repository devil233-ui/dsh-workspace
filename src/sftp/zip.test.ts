/*
 * @Description: 流式 ZIP 与打包计划的测试 —— 自己解析产物（中央目录 + inflate + CRC 校验），不依赖解压库
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/sftp/zip.test.ts
 */
import { describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { Readable } from 'node:stream'
import { inflateRawSync } from 'node:zlib'
import { ZipWriter, crc32, dosDateTime } from './zip.js'
import { ArchiveLimitError, outermost, planArchive, uniqueTopNames, writeArchive, type ArchiveSource } from './archive.js'
import { archiveName, parseArchivePaths } from './http.js'

async function collect(zip: ZipWriter): Promise<Buffer> {
  const chunks: Buffer[] = []
  zip.output.on('data', (c: Buffer) => chunks.push(c))
  await new Promise<void>((r) => zip.output.once('end', () => r()))
  return Buffer.concat(chunks)
}

/** 按中央目录解出全部条目（同时核对本地头、数据描述符与 CRC）。 */
function unzip(buf: Buffer): Array<{ name: string; data: Buffer; dir: boolean; external: number }> {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  expect(eocd).toBeGreaterThan(-1)
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: Array<{ name: string; data: Buffer; dir: boolean; external: number }> = []
  for (let i = 0; i < count; i += 1) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50)
    const flags = buf.readUInt16LE(p + 8)
    const method = buf.readUInt16LE(p + 10)
    const crc = buf.readUInt32LE(p + 16)
    const comp = buf.readUInt32LE(p + 20)
    const size = buf.readUInt32LE(p + 24)
    const nameLen = buf.readUInt16LE(p + 28)
    const external = buf.readUInt32LE(p + 38)
    const offset = buf.readUInt32LE(p + 42)
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    expect(flags & 0x0800).toBe(0x0800)
    expect(buf.readUInt32LE(offset)).toBe(0x04034b50)
    const localNameLen = buf.readUInt16LE(offset + 26)
    const dataStart = offset + 30 + localNameLen + buf.readUInt16LE(offset + 28)
    const raw = buf.subarray(dataStart, dataStart + comp)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    expect(data.length).toBe(size)
    expect(crc32(data)).toBe(crc)
    if (flags & 0x08) {
      // 数据描述符紧跟数据：签名 + crc + 压缩大小 + 原始大小
      expect(buf.readUInt32LE(dataStart + comp)).toBe(0x08074b50)
      expect(buf.readUInt32LE(dataStart + comp + 4)).toBe(crc)
    }
    out.push({ name, data, dir: name.endsWith('/'), external })
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32)
  }
  return out
}

describe('crc32 / dosDateTime', () => {
  it('标准测试向量，且可分段累计', () => {
    expect(crc32(Buffer.from('123456789'))).toBe(0xcbf43926)
    expect(crc32(Buffer.from('6789'), crc32(Buffer.from('12345')))).toBe(0xcbf43926)
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
  it('1980 年之前夹到 1980-01-01；秒按 2 秒精度', () => {
    expect(dosDateTime(0)).toEqual({ date: 33, time: 0 })
    const d = dosDateTime(new Date(2026, 9, 10, 15, 4, 7).getTime())
    expect(d.date).toBe(((2026 - 1980) << 9) | (10 << 5) | 10)
    expect(d.time).toBe((15 << 11) | (4 << 5) | 3)
  })
})

describe('ZipWriter', () => {
  it('目录 + 文本 + 空文件 + 中文名 + 大文件（多块）都能还原，CRC 与大小一致', async () => {
    const zip = new ZipWriter()
    const done = collect(zip)
    const big = Buffer.alloc(300_000)
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 31) % 251
    await zip.addDirectory('项目', Date.now())
    await zip.addFile('项目/说明.md', Readable.from([Buffer.from('# 你好\n')]), Date.now())
    await zip.addFile('项目/empty.txt', Readable.from([]), Date.now())
    await zip.addFile('项目/big.bin', Readable.from([big.subarray(0, 100_000), big.subarray(100_000)]), Date.now(), { mode: 0o755 })
    await zip.addFile('项目/pic.png', Readable.from([Buffer.from('png-bytes')]), Date.now())
    await zip.finish()
    const entries = unzip(await done)
    expect(entries.map((e) => e.name)).toEqual(['项目/', '项目/说明.md', '项目/empty.txt', '项目/big.bin', '项目/pic.png'])
    expect(entries[1]?.data.toString('utf8')).toBe('# 你好\n')
    expect(entries[2]?.data.length).toBe(0)
    expect(entries[3]?.data.equals(big)).toBe(true)
    // 外部属性高 16 位 = Unix 模式（目录 / 普通文件 + 权限位）
    expect((entries[0]?.external ?? 0) >>> 16).toBe(0o40755)
    expect((entries[3]?.external ?? 0) >>> 16).toBe(0o100755)
  })

  it('拒绝 .. 与空名；源出错时 addFile 抛错', async () => {
    const zip = new ZipWriter()
    zip.output.resume()
    await expect(zip.addFile('../evil', Readable.from([]), 0)).rejects.toThrow(/非法/)
    await expect(zip.addDirectory('', 0)).rejects.toThrow(/非法/)
    const bad = new Readable({
      read() {
        this.destroy(new Error('boom'))
      }
    })
    await expect(zip.addFile('a.txt', bad, 0)).rejects.toThrow(/boom/)
  })

  it('文件在打包时变大超过 maxBytes 中止', async () => {
    const zip = new ZipWriter()
    zip.output.resume()
    await expect(zip.addFile('grow.log', Readable.from([Buffer.alloc(10), Buffer.alloc(10)]), 0, { maxBytes: 15 })).rejects.toThrow(/变大/)
  })

  it('输出被关闭（下载取消）后写入报错，不会挂起', async () => {
    const zip = new ZipWriter()
    zip.output.destroy()
    await new Promise((r) => setImmediate(r))
    await expect(zip.addDirectory('a', 0)).rejects.toThrow(/已关闭/)
  })
})

/** 内存里的假文件系统（POSIX 路径）。 */
function memSource(files: Record<string, string | null>): ArchiveSource {
  // value: 字符串 = 文件内容；null = 目录；'@link' = 符号链接
  return {
    async lstat(p) {
      const v = files[p]
      if (v === undefined) throw Object.assign(new Error('nope'), { code: 'ENOENT' })
      if (v === '@link') return { kind: 'other', size: 0, mtime: 0, mode: 0o777 }
      return v === null ? { kind: 'dir', size: 0, mtime: 0, mode: 0o755 } : { kind: 'file', size: Buffer.byteLength(v), mtime: 0, mode: 0o644 }
    },
    async readdir(p) {
      const prefix = p === '/' ? '/' : `${p}/`
      return Object.keys(files)
        .filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/') && k !== p)
        .map((k) => k.slice(prefix.length))
    },
    open: (p) => Readable.from([Buffer.from(files[p] as string)]),
    join: (d, n) => path.posix.join(d, n),
    base: (p) => path.posix.basename(p)
  }
}

describe('planArchive', () => {
  const fs = memSource({
    '/w': null,
    '/w/a': null,
    '/w/a/x.txt': 'xx',
    '/w/a/link': '@link',
    '/w/a/empty': null,
    '/w/b': null,
    '/w/b/x.txt': 'yyy',
    '/w/c.txt': 'c'
  })

  it('递归列出目录与文件，跳过符号链接，统计文件数与字节', async () => {
    const plan = await planArchive(fs, ['/w/a', '/w/c.txt'])
    expect(plan.entries.map((e) => e.name)).toEqual(['a/', 'a/empty/', 'a/x.txt', 'c.txt'])
    expect(plan.files).toBe(2)
    expect(plan.bytes).toBe(3)
  })

  it('同时选中目录与其子项只打包一次；不同目录的同名顶层项改名', async () => {
    const plan = await planArchive(fs, ['/w/a', '/w/a/x.txt', '/w/a/x.txt/', '/w/b/x.txt'])
    expect(plan.entries.map((e) => e.name)).toEqual(['a/', 'a/empty/', 'a/x.txt', 'x.txt'])
    const twin = await planArchive(fs, ['/w/a/x.txt', '/w/b/x.txt'])
    expect(twin.entries.map((e) => e.name)).toEqual(['x.txt', 'x (2).txt'])
  })

  it('超过文件数 / 总字节上限时抛 ArchiveLimitError；只有链接时报没有可打包文件', async () => {
    await expect(planArchive(fs, ['/w'], { maxFiles: 2 })).rejects.toBeInstanceOf(ArchiveLimitError)
    await expect(planArchive(fs, ['/w'], { maxBytes: 4 })).rejects.toBeInstanceOf(ArchiveLimitError)
    await expect(planArchive(fs, ['/w/a/link'])).rejects.toThrow(/没有可打包/)
    await expect(planArchive(fs, [])).rejects.toThrow()
  })

  it('writeArchive 按计划写出可解压的 ZIP', async () => {
    const plan = await planArchive(fs, ['/w'])
    const zip = new ZipWriter()
    const done = collect(zip)
    await writeArchive(fs, plan, zip)
    const entries = unzip(await done)
    expect(entries.filter((e) => !e.dir).map((e) => `${e.name}=${e.data.toString()}`)).toEqual(['w/a/x.txt=xx', 'w/b/x.txt=yyy', 'w/c.txt=c'])
  })
})

describe('打包辅助函数', () => {
  it('outermost：去掉被包含的子路径与重复项，保持顺序', () => {
    expect(outermost(['/a/b', '/a', '/c', '/a/b/c', '/c/', '/ab'])).toEqual(['/a', '/c', '/ab'])
    expect(outermost(['/C:/w/x', '/C:/w'])).toEqual(['/C:/w'])
  })
  it('uniqueTopNames：同名（不区分大小写）依次加序号', () => {
    expect(uniqueTopNames(['a.txt', 'A.txt', 'a.txt', 'dir', 'dir'])).toEqual(['a.txt', 'A (2).txt', 'a (3).txt', 'dir', 'dir (2)'])
  })
  it('parseArchivePaths / archiveName：外形校验与文件名清理', () => {
    expect(parseArchivePaths({ paths: ['/a', '/b'] })).toEqual(['/a', '/b'])
    expect(() => parseArchivePaths({ paths: [] })).toThrow()
    expect(() => parseArchivePaths({ paths: ['rel'] })).toThrow()
    expect(() => parseArchivePaths({ paths: ['/a\nb'] })).toThrow()
    expect(() => parseArchivePaths({ paths: Array.from({ length: 1001 }, (_, i) => `/f${i}`) })).toThrow(ArchiveLimitError)
    expect(archiveName({ name: '../x:y.zip' }, 'w', 1)).toBe('.._x_y.zip')
    expect(archiveName({}, 'src', 1)).toBe('src.zip')
    expect(archiveName({}, 'src', 3)).toBe('archive.zip')
  })
})

describe('本机来源（真实文件系统）', () => {
  it('打包临时目录；符号链接被跳过', async () => {
    const { localArchiveSource } = await import('./archive.js')
    const dir = mkdtempSync(path.join(tmpdir(), 'dshws-zip-'))
    try {
      mkdirSync(path.join(dir, 'sub'))
      writeFileSync(path.join(dir, 'sub', 'a.txt'), 'hello')
      writeFileSync(path.join(dir, 'b.txt'), 'world')
      try {
        symlinkSync(path.join(dir, 'b.txt'), path.join(dir, 'sub', 'ln'))
      } catch {
        /* Windows 无权限创建符号链接时跳过这一项 */
      }
      const src = localArchiveSource({ resolve: async (_id: string, p: string) => p } as never, 's')
      const plan = await planArchive(src, [path.join(dir, 'sub'), path.join(dir, 'b.txt')])
      expect(plan.entries.map((e) => e.name)).toEqual(['sub/', 'sub/a.txt', 'b.txt'])
      const zip = new ZipWriter()
      const done = collect(zip)
      await writeArchive(src, plan, zip)
      const entries = unzip(await done)
      expect(entries.find((e) => e.name === 'sub/a.txt')?.data.toString()).toBe('hello')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
