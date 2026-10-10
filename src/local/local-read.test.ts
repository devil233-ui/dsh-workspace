/*
 * @Description: 本机只读通道测试 —— 路径校验（任意路径可读、拒绝相对 / UNC / 设备路径）、读取、HTTP Range 解析
 * @Author: YangHeng
 * @Date: 2026-10-10 12:30:00
 * @FilePath: /dsh-workspace/src/local/local-read.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { LocalPathError, localReader, resolveReadablePath } from './local-fs.js'
import { inlineMimeOf, parseRange } from '../sftp/http.js'

describe('resolveReadablePath', () => {
  it('Windows：盘符路径（正反斜杠）与本地 POSIX 形式都认，并规范化', () => {
    expect(resolveReadablePath('C:\\Users\\me\\a.txt', 'win32')).toBe('C:\\Users\\me\\a.txt')
    expect(resolveReadablePath('C:/Users/me/./x/../a.txt', 'win32')).toBe('C:\\Users\\me\\a.txt')
    expect(resolveReadablePath('/C:/Users/me/a.txt', 'win32')).toBe('C:\\Users\\me\\a.txt')
    expect(resolveReadablePath('D:', 'win32')).toBe('D:\\')
  })

  it('【安全】Windows：拒绝相对路径、UNC、设备路径与控制字符', () => {
    for (const bad of ['a.txt', '..\\x', '\\\\server\\share\\a', '//server/share/a', '\\\\?\\C:\\a', '\\\\.\\PhysicalDrive0', 'C:\\a\u0000b', '/home/me/a']) {
      expect(() => resolveReadablePath(bad, 'win32'), bad).toThrow(LocalPathError)
    }
  })

  it('POSIX：只认 / 开头的绝对路径', () => {
    expect(resolveReadablePath('/home/me/../x/a.md', 'linux')).toBe('/home/x/a.md')
    expect(() => resolveReadablePath('home/me/a.md', 'linux')).toThrow(LocalPathError)
    expect(() => resolveReadablePath('', 'darwin')).toThrow(LocalPathError)
  })
})

describe('localReader（任意本机路径只读）', () => {
  let dir: string
  beforeAll(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'dshws-read-'))
    writeFileSync(path.join(dir, 'a.md'), '# 标题\n')
    writeFileSync(path.join(dir, 'b.bin'), Buffer.from([1, 0, 2, 3]))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('读文本：带 mtime 与大小，路径返回本地 POSIX 形式', async () => {
    const r = await localReader.readText(path.join(dir, 'a.md'), 1024)
    expect(r.content).toBe('# 标题\n')
    expect(r.mtime).toBeGreaterThan(0)
    expect(r.binary).toBe(false)
    expect(r.path.endsWith('/a.md')).toBe(true)
  })

  it('超过上限：文本截断，字节读取直接拒绝', async () => {
    const r = await localReader.readText(path.join(dir, 'a.md'), 2)
    expect(r.truncated).toBe(true)
    await expect(localReader.readData(path.join(dir, 'b.bin'), 2)).rejects.toThrow(/过大/)
    const d = await localReader.readData(path.join(dir, 'b.bin'), 1024)
    expect(Buffer.from(d.base64, 'base64')).toEqual(Buffer.from([1, 0, 2, 3]))
    expect(d.mtime).toBeGreaterThan(0)
  })

  it('二进制嗅探；目录不能读', async () => {
    expect((await localReader.readText(path.join(dir, 'b.bin'), 1024)).binary).toBe(true)
    await expect(localReader.readText(dir, 1024)).rejects.toThrow(/普通文件/)
  })

  it('按区间开流（Range）', async () => {
    const opened = await localReader.openDownload(path.join(dir, 'b.bin'), (size) => ({ start: 1, end: size - 1 }))
    const chunks: Buffer[] = []
    for await (const c of opened.stream) chunks.push(c as Buffer)
    expect(Buffer.concat(chunks)).toEqual(Buffer.from([0, 2, 3]))
    expect(opened.range).toEqual({ start: 1, end: 3 })
  })
})

describe('parseRange', () => {
  it('常规、开放与后缀区间', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=900-', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=990-5000', 1000)).toEqual({ start: 990, end: 999 })
  })

  it('越界返回 invalid（416），不认识的写法忽略（按整文件返回）', () => {
    expect(parseRange('bytes=1000-', 1000)).toBe('invalid')
    expect(parseRange('bytes=5-1', 1000)).toBe('invalid')
    expect(parseRange(undefined, 1000)).toBeUndefined()
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeUndefined()
    expect(parseRange('items=0-1', 1000)).toBeUndefined()
  })
})

describe('inlineMimeOf', () => {
  it('【安全】只有图片 / 音视频 / PDF 可内联；HTML、SVG 一律不内联', () => {
    expect(inlineMimeOf('a.MP4')).toBe('video/mp4')
    expect(inlineMimeOf('a.pdf')).toBe('application/pdf')
    expect(inlineMimeOf('a.html')).toBeUndefined()
    expect(inlineMimeOf('a.svg')).toBeUndefined()
    expect(inlineMimeOf('noext')).toBeUndefined()
  })
})
