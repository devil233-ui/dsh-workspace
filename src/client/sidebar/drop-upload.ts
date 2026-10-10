/*
 * @Description: 拖放上传 —— 把拖入的文件 / 文件夹展开成「文件 + 相对子目录」清单
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/drop-upload.ts
 *
 * 文件夹要经 webkitGetAsEntry 递归读取（DataTransfer.files 里文件夹只是一个 0 字节的假文件）。
 * 注意：webkitGetAsEntry 必须在 drop 事件处理函数里同步调用，事件结束后 DataTransfer 就清空了 —— 所以先同步取条目，再异步遍历。
 */
import type { UploadItem } from './file-menu.js'

/** 单次拖放最多上传的文件数（防止误拖整个大目录把浏览器卡死）。 */
export const DROP_MAX_FILES = 5000

export class DropTooManyError extends Error {}

/** 拖动的是不是外部文件（不是页面内的文字 / 链接拖动）。 */
export function isFileDrag(dt: DataTransfer | null): boolean {
  return dt !== null && [...dt.types].includes('Files')
}

/** 同步取出拖放条目；返回的函数再异步展开成清单。 */
export function takeDrop(dt: DataTransfer): () => Promise<UploadItem[]> {
  const entries: FileSystemEntry[] = []
  for (const item of [...dt.items]) {
    if (item.kind !== 'file') continue
    const entry = typeof item.webkitGetAsEntry === 'function' ? item.webkitGetAsEntry() : null
    if (entry !== null) entries.push(entry)
  }
  const files = [...dt.files]
  return async () => {
    if (entries.length === 0) return files.map((file) => ({ file, relDir: '' }))
    const out: UploadItem[] = []
    for (const e of entries) await walk(e, '', out)
    return out
  }
}

async function walk(entry: FileSystemEntry, relDir: string, out: UploadItem[]): Promise<void> {
  if (entry.isFile) {
    if (out.length >= DROP_MAX_FILES) throw new DropTooManyError(String(DROP_MAX_FILES))
    const file = await new Promise<File>((resolve, reject) => (entry as FileSystemFileEntry).file(resolve, reject))
    out.push({ file, relDir })
    return
  }
  if (!entry.isDirectory) return
  const dir = relDir === '' ? entry.name : `${relDir}/${entry.name}`
  const reader = (entry as FileSystemDirectoryEntry).createReader()
  // readEntries 每次最多返回约 100 条，要读到返回空数组为止。
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve, reject) => reader.readEntries(resolve, reject))
    if (batch.length === 0) break
    for (const child of batch) await walk(child, dir, out)
  }
  // 空文件夹：没有文件也要建出来 —— 用一个占位标记交给上传方建目录。
  if (!out.some((i) => i.relDir === dir || i.relDir.startsWith(`${dir}/`))) out.push({ file: EMPTY_DIR, relDir: dir })
}

/** 空目录占位（上传方见到它只建目录、不上传文件）。 */
export const EMPTY_DIR = new File([], '.dshws-empty-dir')
