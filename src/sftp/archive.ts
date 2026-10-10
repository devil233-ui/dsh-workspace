/*
 * @Description: 多选「压缩并下载」—— 打包计划（遍历 + 上限检查）与远程 / 本机的文件来源
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/sftp/archive.ts
 *
 * 两步走（见 http.ts 的 archive 路由）：
 * 1. 先遍历出完整的条目清单并检查上限（文件数、总字节），超限在还没开始下载前就以 JSON 报错；
 * 2. 再按清单逐个读取、流式压缩输出。
 * 符号链接一律跳过（不跟随）：跟随链接可能把工作区外 / 远端任意位置的内容打进包里，也可能形成环。
 * 路径范围：远程沿用下载路由的规则（保险箱里的主机 + 规范化绝对路径）；本机经 LocalFs.resolve 限制在会话工作区内。
 */
import { createReadStream } from 'node:fs'
import { lstat, readdir } from 'node:fs/promises'
import path from 'node:path'
import type { Readable } from 'node:stream'
import type { LocalFs } from '../local/local-fs.js'
import { normalizeRemotePath, typeOfMode, type RemoteFs, type SftpLike } from './remote-fs.js'
import type { ZipWriter } from './zip.js'
import { outermost } from '../wire/path-set.js'

export { outermost }

/** 打包上限：文件数与未压缩总字节（远低于 ZIP 不用 ZIP64 时的 65535 条 / 4GB）。 */
export const ARCHIVE_MAX_FILES = 10_000
export const ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024
/** 一次最多选中多少个顶层路径。 */
export const ARCHIVE_MAX_PATHS = 1000
const MAX_DEPTH = 64

export interface ArchiveStat {
  kind: 'dir' | 'file' | 'other'
  size: number
  mtime: number
  mode: number
}

/** 打包用的最小文件系统面（远程 / 本机各实现一份）。路径为该来源自己的写法（远程 POSIX、本机原生）。 */
export interface ArchiveSource {
  /** 不跟随符号链接；符号链接返回 kind 'other'。 */
  lstat(p: string): Promise<ArchiveStat>
  readdir(p: string): Promise<string[]>
  open(p: string): Readable
  join(dir: string, name: string): string
  base(p: string): string
}

export interface ArchiveEntry {
  /** 包内名称（正斜杠）。 */
  name: string
  /** 来源路径（目录条目也有）。 */
  source: string
  dir: boolean
  size: number
  mtime: number
  mode: number
}

export interface ArchivePlan {
  entries: ArchiveEntry[]
  files: number
  bytes: number
}

export class ArchiveLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ArchiveLimitError'
  }
}

function formatGB(bytes: number): string {
  const gb = bytes / 1024 / 1024 / 1024
  return gb >= 1 ? `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 / 1024)} MB`
}

/**
 * 同名顶层项（从不同目录选中的 a/x 与 b/x）在包里改名为「x (2)」，避免互相覆盖。
 * 纯函数，便于单测。
 */
export function uniqueTopNames(names: readonly string[]): string[] {
  const used = new Set<string>()
  return names.map((name) => {
    let candidate = name
    for (let n = 2; used.has(candidate.toLowerCase()); n += 1) {
      const dot = name.lastIndexOf('.')
      candidate = dot > 0 ? `${name.slice(0, dot)} (${n})${name.slice(dot)}` : `${name} (${n})`
    }
    used.add(candidate.toLowerCase())
    return candidate
  })
}

/**
 * 遍历选中的路径，生成条目清单；超过上限立即抛 ArchiveLimitError（不会读到最后才发现）。
 * 选中项里已被其他选中目录包含的（a 与 a/b 同时选）只保留外层。
 */
export async function planArchive(
  src: ArchiveSource,
  paths: readonly string[],
  limits: { maxFiles?: number; maxBytes?: number } = {}
): Promise<ArchivePlan> {
  const maxFiles = limits.maxFiles ?? ARCHIVE_MAX_FILES
  const maxBytes = limits.maxBytes ?? ARCHIVE_MAX_BYTES
  if (paths.length === 0) throw new Error('没有选择要打包的文件。')
  if (paths.length > ARCHIVE_MAX_PATHS) throw new ArchiveLimitError(`一次最多选择 ${ARCHIVE_MAX_PATHS} 项。`)
  const tops = outermost(paths)
  const names = uniqueTopNames(tops.map((p) => src.base(p)))
  const plan: ArchivePlan = { entries: [], files: 0, bytes: 0 }

  const visit = async (p: string, name: string, depth: number): Promise<void> => {
    const st = await src.lstat(p)
    if (st.kind === 'other') return
    if (st.kind === 'file') {
      plan.files += 1
      plan.bytes += st.size
      if (plan.files > maxFiles) throw new ArchiveLimitError(`文件过多：最多打包 ${maxFiles} 个文件。`)
      if (plan.bytes > maxBytes) throw new ArchiveLimitError(`总大小超过上限（${formatGB(maxBytes)}）。`)
      plan.entries.push({ name, source: p, dir: false, size: st.size, mtime: st.mtime, mode: st.mode })
      return
    }
    if (depth > MAX_DEPTH) throw new ArchiveLimitError(`目录层级过深（超过 ${MAX_DEPTH} 层）：${p}`)
    plan.entries.push({ name: `${name}/`, source: p, dir: true, size: 0, mtime: st.mtime, mode: st.mode })
    if (plan.entries.length > maxFiles * 2) throw new ArchiveLimitError(`条目过多：最多打包 ${maxFiles} 个文件。`)
    const children = (await src.readdir(p)).filter((c) => c !== '.' && c !== '..').sort((a, b) => a.localeCompare(b))
    for (const child of children) await visit(src.join(p, child), `${name}/${child}`, depth + 1)
  }

  for (let i = 0; i < tops.length; i += 1) await visit(tops[i] as string, names[i] as string, 0)
  if (plan.files === 0 && plan.entries.length === 0) throw new Error('选中的项目里没有可打包的文件（符号链接不会被打包）。')
  return plan
}

/** 按清单写出 ZIP。isAborted 返回 true（下载方已断开）时停止。 */
export async function writeArchive(src: ArchiveSource, plan: ArchivePlan, zip: ZipWriter, isAborted: () => boolean = () => false): Promise<void> {
  // 遍历之后文件可能变大（正在写入的日志）：允许单个文件超出遍历时的大小，但累计不得突破总上限。
  let slack = Math.max(0, ARCHIVE_MAX_BYTES - plan.bytes)
  for (const e of plan.entries) {
    if (isAborted()) throw new Error('下载已取消。')
    if (e.dir) {
      await zip.addDirectory(e.name, e.mtime)
      continue
    }
    const r = await zip.addFile(e.name, src.open(e.source), e.mtime, { mode: e.mode, maxBytes: e.size + slack })
    slack -= Math.max(0, r.size - e.size)
  }
  await zip.finish()
}

// ------------------------------------------------------------------ 来源

type Cb<T> = (err: (Error & { code?: number }) | null | undefined, value: T) => void
function call<T>(fn: (cb: Cb<T>) => void): Promise<T> {
  return new Promise((resolve, reject) => fn((err, value) => (err !== null && err !== undefined ? reject(err) : resolve(value))))
}

/** 远程（SFTP）来源。路径先规范化（与下载路由一致：绝对路径、无 NUL）。 */
export async function remoteArchiveSource(fs: RemoteFs, hostId: string): Promise<ArchiveSource> {
  const sftp: SftpLike = await fs.sftp(hostId)
  return {
    async lstat(p) {
      const a = await call<{ mode: number; size: number; mtime: number }>((cb) => sftp.lstat(normalizeRemotePath(p), cb))
      const t = typeOfMode(a.mode)
      return { kind: t === 'dir' ? 'dir' : t === 'file' ? 'file' : 'other', size: a.size, mtime: a.mtime * 1000, mode: a.mode & 0o7777 }
    },
    async readdir(p) {
      const list = await call<Array<{ filename: string }>>((cb) => sftp.readdir(normalizeRemotePath(p), cb))
      return list.map((e) => e.filename)
    },
    open: (p) => sftp.createReadStream(normalizeRemotePath(p)),
    join: (dir, name) => path.posix.join(dir, name),
    base: (p) => path.posix.basename(normalizeRemotePath(p)) || 'root'
  }
}

/**
 * 本机来源：顶层路径经 LocalFs.resolve 校验在会话工作区内（不跟随最后一段的链接，链接本身随后被 lstat 跳过）；
 * 子项由已校验的目录 readdir 得到且不跟随链接，所以不会走出工作区。
 * 返回 resolvePaths 把线上路径（本地 POSIX 形式）换成原生路径，供 planArchive 使用。
 */
export function localArchiveSource(localFs: LocalFs, id: string): ArchiveSource & { resolvePaths(paths: readonly string[]): Promise<string[]> } {
  return {
    async resolvePaths(paths) {
      const out: string[] = []
      for (const p of paths) out.push(await localFs.resolve(id, p, false))
      return out
    },
    async lstat(p) {
      const s = await lstat(p)
      const kind = s.isSymbolicLink() ? 'other' : s.isDirectory() ? 'dir' : s.isFile() ? 'file' : 'other'
      return { kind, size: s.size, mtime: Math.floor(s.mtimeMs), mode: s.mode & 0o7777 }
    },
    readdir: (p) => readdir(p),
    open: (p) => createReadStream(p),
    join: (dir, name) => path.join(dir, name),
    base: (p) => path.basename(p) || 'root'
  }
}
