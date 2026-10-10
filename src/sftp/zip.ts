/*
 * @Description: 最小的流式 ZIP 写入器（deflate + 数据描述符，不依赖第三方库）
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/sftp/zip.ts
 *
 * 为什么自己写：侧栏「压缩并下载」只需要「边读边压边发」，现有依赖里没有 zip 实现，
 * 为此引入 archiver 这类库（连带十几个依赖）不划算。格式要点：
 * - 文件条目用通用标志位 bit 3（大小与 CRC 写在数据之后的数据描述符里），这样不必先读完文件、可以真正流式输出；
 * - bit 11 = 文件名为 UTF-8（中文名在 Windows 资源管理器 / macOS / unzip 里都不乱码）；
 * - 不支持 ZIP64：调用方必须把总量限制在 4GB 与 65535 个条目以内（archive.ts 的上限远低于此），越界直接报错而不是写出坏包。
 */
import { PassThrough, Transform, Writable, type Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createDeflateRaw } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

/** CRC-32（IEEE），可分段累计：crc32(b, crc32(a)) === crc32(a + b)。 */
export function crc32(buf: Uint8Array, previous = 0): number {
  let c = (previous ^ 0xffffffff) >>> 0
  for (let i = 0; i < buf.length; i += 1) c = (CRC_TABLE[(c ^ (buf[i] as number)) & 0xff] as number) ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

/** 时间戳（毫秒）→ DOS 日期 / 时间（本地时间，2 秒精度；早于 1980 的按 1980-01-01）。 */
export function dosDateTime(ms: number): { date: number; time: number } {
  const d = new Date(Number.isFinite(ms) ? ms : Date.now())
  if (d.getFullYear() < 1980) return { date: (0 << 9) | (1 << 5) | 1, time: 0 }
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  return { date, time }
}

/** 已经压缩过的格式：再 deflate 只费 CPU，用最快档。 */
const COMPRESSED_EXT = /\.(zip|gz|tgz|bz2|xz|7z|rar|zst|png|jpe?g|gif|webp|avif|heic|mp3|mp4|m4a|m4v|mov|mkv|webm|ogg|opus|flac|pdf|docx|xlsx|pptx|woff2?)$/i

const MAX_U32 = 0xffffffff
const MAX_ENTRIES = 0xffff

interface CentralRecord {
  name: Buffer
  flags: number
  method: number
  date: number
  time: number
  crc: number
  compressed: number
  size: number
  external: number
  offset: number
}

/**
 * 流式 ZIP 写入器：条目必须串行添加（上一个 await 完再加下一个）。
 * output 背压：消费方（HTTP 响应）读得慢时 write 会等 drain；消费方关闭后后续写入抛错，调用方据此停止读取源文件。
 */
export class ZipWriter {
  readonly output = new PassThrough()
  private offset = 0
  private records: CentralRecord[] = []
  private closed = false
  private finished = false

  constructor() {
    this.output.on('close', () => {
      this.closed = true
    })
  }

  /** 已写出的字节数。 */
  get bytesWritten(): number {
    return this.offset
  }

  private async write(buf: Buffer): Promise<void> {
    if (this.closed || this.output.destroyed) throw new Error('ZIP 输出已关闭。')
    this.offset += buf.length
    if (this.output.write(buf)) return
    await new Promise<void>((resolve, reject) => {
      const done = (): void => {
        this.output.off('drain', done)
        this.output.off('close', gone)
        resolve()
      }
      const gone = (): void => {
        this.output.off('drain', done)
        this.output.off('close', gone)
        reject(new Error('ZIP 输出已关闭。'))
      }
      this.output.on('drain', done)
      this.output.on('close', gone)
    })
  }

  private encodeName(name: string, dir: boolean): Buffer {
    // 统一正斜杠、去掉开头的 /（解压时不应写到根目录），目录以 / 结尾。
    let n = name.replace(/\\/g, '/').replace(/^\/+/, '')
    if (n === '' || n.split('/').includes('..')) throw new Error(`非法的条目名：${name}`)
    if (dir && !n.endsWith('/')) n += '/'
    const buf = Buffer.from(n, 'utf8')
    if (buf.length > 0xffff) throw new Error(`条目名过长：${name}`)
    return buf
  }

  private checkRoom(): void {
    if (this.finished) throw new Error('ZIP 已结束，不能再添加条目。')
    if (this.records.length >= MAX_ENTRIES) throw new Error('条目超过 65535 个（不支持 ZIP64）。')
    if (this.offset > MAX_U32) throw new Error('压缩包超过 4GB（不支持 ZIP64）。')
  }

  private localHeader(name: Buffer, flags: number, method: number, date: number, time: number, crc: number, compressed: number, size: number): Buffer {
    const h = Buffer.alloc(30)
    h.writeUInt32LE(0x04034b50, 0)
    h.writeUInt16LE(20, 4)
    h.writeUInt16LE(flags, 6)
    h.writeUInt16LE(method, 8)
    h.writeUInt16LE(time, 10)
    h.writeUInt16LE(date, 12)
    h.writeUInt32LE(crc, 14)
    h.writeUInt32LE(compressed, 18)
    h.writeUInt32LE(size, 22)
    h.writeUInt16LE(name.length, 26)
    h.writeUInt16LE(0, 28)
    return Buffer.concat([h, name])
  }

  /** 目录条目（空目录也要有，解压后才能还原目录结构）。 */
  async addDirectory(name: string, mtime: number): Promise<void> {
    this.checkRoom()
    const enc = this.encodeName(name, true)
    const { date, time } = dosDateTime(mtime)
    const offset = this.offset
    await this.write(this.localHeader(enc, 0x0800, 0, date, time, 0, 0, 0))
    this.records.push({ name: enc, flags: 0x0800, method: 0, date, time, crc: 0, compressed: 0, size: 0, external: ((0o40755 << 16) | 0x10) >>> 0, offset })
  }

  /**
   * 文件条目：边读边 deflate 边写出。source 出错时整个 ZIP 不可用，错误原样抛给调用方（由它中止响应）。
   * maxBytes：源实际读到的字节超过它就中止（列目录之后文件可能被改大，防止突破总量上限）。
   */
  async addFile(name: string, source: Readable, mtime: number, options: { mode?: number; maxBytes?: number } = {}): Promise<{ size: number; compressed: number }> {
    this.checkRoom()
    const enc = this.encodeName(name, false)
    const { date, time } = dosDateTime(mtime)
    const flags = 0x0808
    const offset = this.offset
    await this.write(this.localHeader(enc, flags, 8, date, time, 0, 0, 0))

    let crc = 0
    let size = 0
    let compressed = 0
    const limit = Math.min(options.maxBytes ?? MAX_U32, MAX_U32)
    const measure = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        size += chunk.length
        if (size > limit) {
          cb(new Error(`文件在打包过程中变大，超过上限：${name}`))
          return
        }
        crc = crc32(chunk, crc)
        cb(null, chunk)
      }
    })
    const sink = new Writable({
      write: (chunk: Buffer, _enc, cb) => {
        compressed += chunk.length
        this.write(chunk).then(() => cb(), cb)
      }
    })
    await pipeline(source, measure, createDeflateRaw({ level: COMPRESSED_EXT.test(name) ? 1 : 6 }), sink)
    if (compressed > MAX_U32) throw new Error(`单个文件压缩后超过 4GB（不支持 ZIP64）：${name}`)

    const dd = Buffer.alloc(16)
    dd.writeUInt32LE(0x08074b50, 0)
    dd.writeUInt32LE(crc, 4)
    dd.writeUInt32LE(compressed, 8)
    dd.writeUInt32LE(size, 12)
    await this.write(dd)
    const mode = (options.mode ?? 0o644) & 0o7777
    this.records.push({ name: enc, flags, method: 8, date, time, crc, compressed, size, external: (((0o100000 | mode) << 16) >>> 0), offset })
    return { size, compressed }
  }

  /** 写中央目录与结尾记录并结束输出。 */
  async finish(): Promise<void> {
    if (this.finished) return
    this.finished = true
    const start = this.offset
    if (start > MAX_U32) throw new Error('压缩包超过 4GB（不支持 ZIP64）。')
    for (const r of this.records) {
      const h = Buffer.alloc(46)
      h.writeUInt32LE(0x02014b50, 0)
      // 高字节 3 = Unix：外部属性的高 16 位按 Unix 权限位解释（解压时还原目录 / 文件类型与权限）。
      h.writeUInt16LE((3 << 8) | 20, 4)
      h.writeUInt16LE(20, 6)
      h.writeUInt16LE(r.flags, 8)
      h.writeUInt16LE(r.method, 10)
      h.writeUInt16LE(r.time, 12)
      h.writeUInt16LE(r.date, 14)
      h.writeUInt32LE(r.crc, 16)
      h.writeUInt32LE(r.compressed, 20)
      h.writeUInt32LE(r.size, 24)
      h.writeUInt16LE(r.name.length, 28)
      h.writeUInt16LE(0, 30)
      h.writeUInt16LE(0, 32)
      h.writeUInt16LE(0, 34)
      h.writeUInt16LE(0, 36)
      h.writeUInt32LE(r.external, 38)
      h.writeUInt32LE(r.offset, 42)
      await this.write(Buffer.concat([h, r.name]))
    }
    const size = this.offset - start
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(0, 4)
    end.writeUInt16LE(0, 6)
    end.writeUInt16LE(this.records.length, 8)
    end.writeUInt16LE(this.records.length, 10)
    end.writeUInt32LE(size, 12)
    end.writeUInt32LE(start, 16)
    end.writeUInt16LE(0, 20)
    await this.write(end)
    this.output.end()
  }

  /** 中止：丢弃输出（下载方会收到不完整的响应）。 */
  abort(error?: Error): void {
    this.finished = true
    this.output.destroy(error)
  }
}
