/*
 * @Description: 远程文件树的右键菜单逻辑（远程文件 / 远程 Git 的「文件」页共用）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/file-menu.tsx
 *
 * 菜单项：新建文件 / 新建文件夹 / 上传到此处 / 重命名 / 复制 / 粘贴 / 下载 / 复制相对路径 / 复制绝对路径 / 删除。
 * - 粘贴目标：右键目录 = 该目录；右键文件 = 它所在目录；右键空白处 = 树的根目录
 * - 剪贴板跨面板共享，但只能粘贴到同一台主机
 * - editable=false（查看未检出的分支）时只保留「复制相对路径」：分支里的文件不在磁盘上
 * - 文件管理（方案 3.4）另有：在对话中引用（@）、打开方式（系统默认应用 / VS Code / Cursor / Zed / 自定义模板）、压缩并下载；
 *   多选（selection 返回多于一项且右键的是其中之一）时换成批量菜单：复制路径、引用、压缩并下载、删除（确认里写明数量）。
 */
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react'
import type { WorkspaceApi } from '../api.js'
import type { Translate } from '../context.js'
import { askConfirm, askText, copyText, relativeTo, remoteClipboard, showFloat, useContextMenu, type MenuItem } from './ContextMenu.js'
import { TransferError, downloadArchive, formatSize, startDownload, uploadFile } from '../files/transfer.js'
import { LOCAL_HOST_PREFIX, displayPath, nativeSlashPath } from './remote-index.js'
import { openInApp, openInAppAvailable, referenceInChat } from './host-bridge.js'
import { builtinOpeners, expandTemplate, type OpenTarget } from '../../wire/open-with.js'
import { outermost } from '../../wire/path-set.js'
import { getSidebarPrefs } from '../sidebar-prefs.js'
import { isDesktopRenderer } from '../host-url.js'
import { EMPTY_DIR } from './drop-upload.js'

/** 拖放上传的一项：文件 + 相对拖放目标目录的子目录（文件夹拖入时保留结构；空串 = 直接放在目标目录）。 */
export interface UploadItem {
  file: File
  relDir: string
}

/** 远程主机的连接信息（「打开方式」拼 SSH URL 用），按主机缓存，整页只取一次。 */
const hostInfoCache = new Map<string, Promise<{ host: string; user?: string; port: number } | undefined>>()
function hostInfo(api: WorkspaceApi, hostId: string): Promise<{ host: string; user?: string; port: number } | undefined> {
  let p = hostInfoCache.get(hostId)
  if (p === undefined) {
    p = api.call('state', {}).then(
      (s) => {
        const h = s.hosts.find((x) => x.id === hostId)
        return h === undefined ? undefined : { host: h.hostname, ...(h.username !== undefined && h.username !== '' ? { user: h.username } : {}), port: h.port }
      },
      () => {
        hostInfoCache.delete(hostId)
        return undefined
      }
    )
    hostInfoCache.set(hostId, p)
  }
  return p
}

/** 打开外部 URL：桌面版经宿主（渲染进程拒绝非 http(s) 新窗口），网页版直接交给浏览器。 */
export async function launchUrl(api: WorkspaceApi, url: string): Promise<void> {
  if (isDesktopRenderer()) {
    await api.call('openExternalUrl', { url })
    return
  }
  if (/^https?:/i.test(url)) {
    window.open(url, '_blank', 'noopener')
    return
  }
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

export interface FileMenuOptions {
  t: Translate
  api: WorkspaceApi
  hostId: string
  /** 树根的远程绝对路径（相对路径以它为基准）。 */
  root: string
  /** false：只读树（只提供复制相对路径）。 */
  editable: boolean
  /** 某目录内容变了，需要重载（远程绝对路径）。 */
  reloadDir(dir: string): void
  /** 某条目被改名（打开着的文件据此更新路径）。 */
  onRenamed?(from: string, to: string): void
  /** 粘贴 / 新建出了新条目（目录据此展开）。 */
  onPasted?(dir: string, created: string): void
  /** 新建了文件（面板据此直接打开）。 */
  onCreatedFile?(path: string): void
  /** 条目被删除（打开着的文件据此关闭）。 */
  onRemoved?(path: string): void
  /** 所属会话（「在对话中引用」写入它的输入框）；不传则不提供引用。 */
  sessionId?: string
  /** 当前多选的路径（文件管理传入；多于一项且右键的是其中之一时显示批量菜单）。 */
  selection?(): readonly string[]
  /** 某路径是否目录（批量引用时决定写 @dir/ 还是 @file）。 */
  isDir?(path: string): boolean
  /** 批量操作完成（清空多选）。 */
  onBatchDone?(): void
}

export interface FileMenu {
  node: ReactNode
  /** 在条目上右键。path 为远程绝对路径。 */
  openFor(e: ReactMouseEvent, path: string, isDir: boolean): void
  /** 在树的空白处右键（只有粘贴 / 复制根路径）。 */
  openForRoot(e: ReactMouseEvent): void
  /** 正在重命名的条目（远程绝对路径）。 */
  renaming: string | null
  submitRename(path: string, name: string): Promise<void>
  cancelRename(): void
  /** 把文件（可带子目录结构）上传到 dir（拖放上传用）。 */
  uploadInto(dir: string, items: readonly UploadItem[]): Promise<void>
}

function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function useRemoteFileMenu(opts: FileMenuOptions): FileMenu {
  const { t } = opts
  const [menuNode, open] = useContextMenu()
  const [renaming, setRenaming] = useState<string | null>(null)
  const [, setClipVersion] = useState(0)
  const uploadRef = useRef<HTMLInputElement>(null)
  const uploadDir = useRef<string>(opts.root)
  useEffect(() => remoteClipboard.subscribe(() => setClipVersion((v) => v + 1)), [])

  // 提示一律用浮动气泡（showFloat），不插进列表 —— 否则列表会被推动、抖一下。
  const flash = (text: string): void => showFloat(text)
  const fail = (err: unknown): void => showFloat(err instanceof Error ? err.message : String(err), 'error')
  const local = opts.hostId.startsWith(LOCAL_HOST_PREFIX)
  const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

  /** 名称校验：与宿主端 validateName 一致；本地 Windows 另外不允许 \ : * ? " < > |。 */
  const nameProblem = (value: string): string | undefined => {
    const v = value.trim()
    if (v === '' || v === '.' || v === '..' || /[/\0]/.test(v)) return t('dialog.badName')
    if (local && /^\/[A-Za-z]:/.test(opts.root) && /[\\:*?"<>|]/.test(v)) return t('dialog.badName')
    return undefined
  }

  const paste = async (dir: string): Promise<void> => {
    const c = remoteClipboard.get()
    if (c === null || c.hostId !== opts.hostId) return
    try {
      const r = await opts.api.call('sftpCopy', { hostId: opts.hostId, source: c.path, targetDir: dir })
      opts.reloadDir(dir)
      opts.onPasted?.(dir, r.path)
      flash(t('ctx.pasted', { name: baseName(r.path) }))
    } catch (err) {
      fail(err)
    }
  }

  const copyPath = (text: string): void => {
    void copyText(text).then(() => flash(t('ctx.copiedPath')), fail)
  }

  const canPaste = (): boolean => {
    const c = remoteClipboard.get()
    return c !== null && c.hostId === opts.hostId
  }

  const create = async (dir: string, kind: 'file' | 'dir'): Promise<void> => {
    const name = await askText({
      title: kind === 'dir' ? t('files.newFolderPrompt') : t('files.newFilePrompt'),
      okLabel: t('common.confirm'),
      cancelLabel: t('form.cancel'),
      validate: nameProblem
    })
    if (name === null) return
    try {
      const r = await opts.api.call(kind === 'dir' ? 'sftpMkdir' : 'sftpCreateFile', { hostId: opts.hostId, parent: dir, name: name.trim() })
      opts.reloadDir(dir)
      opts.onPasted?.(dir, r.path)
      if (kind === 'file') opts.onCreatedFile?.(r.path)
    } catch (err) {
      fail(err)
    }
  }

  const remove = async (path: string, isDir: boolean): Promise<void> => {
    const shown = displayPath(path)
    const ok = await askConfirm({
      message: isDir ? t('files.deleteDirConfirm', { path: shown }) : t('files.deleteConfirm', { path: shown }),
      okLabel: t('files.delete'),
      cancelLabel: t('form.cancel'),
      danger: true
    })
    if (!ok) return
    try {
      const r = await opts.api.call('sftpRemove', { hostId: opts.hostId, path })
      opts.reloadDir(parentOf(path))
      opts.onRemoved?.(path)
      flash(t('files.deleted', { files: r.files, dirs: r.dirs }))
    } catch (err) {
      fail(err)
    }
  }

  const join = (dir: string, name: string): string => (dir === '/' ? `/${name}` : `${dir}/${name}`)

  /** 确保 dir 下的子目录 rel（a/b/c）逐级存在；已存在的跳过（mkdir 失败时列父目录确认是不是已有同名目录）。 */
  const ensureDirs = async (dir: string, rel: string, made: Set<string>): Promise<string> => {
    let cur = dir
    for (const seg of rel.split('/').filter(Boolean)) {
      const next = join(cur, seg)
      if (!made.has(next)) {
        try {
          await opts.api.call('sftpMkdir', { hostId: opts.hostId, parent: cur, name: seg })
        } catch (err) {
          const list = await opts.api.call('sftpList', { hostId: opts.hostId, path: cur }).catch(() => undefined)
          if (list?.entries.some((e) => e.name === seg && (e.type === 'dir' || e.linkIsDir === true)) !== true) throw err
        }
        made.add(next)
      }
      cur = next
    }
    return cur
  }

  /** 上传到 dir（同名时询问是否覆盖）；items 带子目录时先建目录（拖入文件夹）。 */
  const uploadInto = async (dir: string, items: readonly UploadItem[]): Promise<void> => {
    const made = new Set<string>()
    let done = 0
    for (const { file, relDir } of items) {
      try {
        const target = relDir === '' ? dir : await ensureDirs(dir, relDir, made)
        if (file === EMPTY_DIR) continue
        const send = (overwrite: boolean) => uploadFile(file, { hostId: opts.hostId, dir: target, name: file.name, overwrite }, () => undefined).promise
        flash(`${t('files.upload')}：${relDir === '' ? '' : `${relDir}/`}${file.name}…`)
        try {
          await send(false)
        } catch (err) {
          if (!(err instanceof TransferError) || !err.isExists) throw err
          const ok = await askConfirm({ message: t('files.overwriteConfirm', { name: file.name }), okLabel: t('common.confirm'), cancelLabel: t('form.cancel'), danger: true })
          if (!ok) continue
          await send(true)
        }
        done += 1
      } catch (err) {
        fail(err)
      }
    }
    if (done > 0) flash(t('files.uploadDone', { count: done }))
    opts.reloadDir(dir)
    for (const d of made) opts.reloadDir(d)
    if (made.size > 0 || done > 0) opts.onPasted?.(dir, dir)
  }

  const uploadFiles = (files: File[]): Promise<void> => uploadInto(uploadDir.current, files.map((file) => ({ file, relDir: '' })))

  // ---------------------------------------------------------------- 引用 / 打开方式 / 打包

  /** 对话里的写法：工作区内用相对路径，工作区外用绝对路径（本机还原成原生写法）。 */
  const chatPath = (p: string): string => {
    const rel = relativeTo(opts.root, p)
    return rel === p ? displayPath(p) : rel
  }

  const reference = async (paths: readonly string[]): Promise<void> => {
    if (opts.sessionId === undefined) return
    const r = await referenceInChat(
      opts.sessionId,
      paths.map((p) => ({ path: chatPath(p), isDir: opts.isDir?.(p) ?? false }))
    )
    if (r === 'inserted') flash(t('ctx.referenced'))
    else if (r === 'copied') flash(t('ctx.referenceCopied'))
    else if (r === 'bad') fail(new Error(t('ctx.referenceBad')))
    else fail(new Error(t('ctx.referenceFailed')))
  }

  const zip = async (paths: readonly string[]): Promise<void> => {
    try {
      flash(t('ctx.zipping'))
      const tops = outermost(paths)
      const r = await downloadArchive(opts.hostId, tops)
      flash(t('ctx.zipStarted', { files: r.files, size: formatSize(r.bytes) }))
    } catch (err) {
      fail(err)
    }
  }

  // 「打开方式」需要的异步信息：宿主能否交给系统打开（本机）、远程主机的连接信息（远程）。打开菜单时同步取用。
  const [osOpen, setOsOpen] = useState(false)
  const [remoteHost, setRemoteHost] = useState<{ host: string; user?: string; port: number } | undefined>(undefined)
  useEffect(() => {
    let live = true
    if (local) void openInAppAvailable().then((ok) => live && setOsOpen(ok))
    else if (opts.hostId !== '') void hostInfo(opts.api, opts.hostId).then((h) => live && setRemoteHost(h))
    return () => {
      live = false
    }
  }, [local, opts.api, opts.hostId])

  const openTarget = (p: string): OpenTarget =>
    local ? { path: nativeSlashPath(p), remote: false } : { path: p, remote: true, ...(remoteHost !== undefined ? remoteHost : {}) }

  /** 子菜单项 id → 动作。 */
  const openWithItems = (p: string): { items: MenuItem[]; run(id: string): void } => {
    const target = openTarget(p)
    const urls = new Map<string, string>()
    const items: MenuItem[] = []
    if (local && osOpen) {
      items.push({ id: 'ow:default', label: t('ctx.openDefault') }, { id: 'ow:reveal', label: t('ctx.revealInOs') }, { type: 'separator' })
    }
    for (const o of builtinOpeners(target)) {
      urls.set(`ow:${o.id}`, o.url)
      items.push({ id: `ow:${o.id}`, label: o.label })
    }
    const templates = getSidebarPrefs().openWith
    if (templates.length > 0) items.push({ type: 'separator' })
    templates.forEach((tpl, i) => {
      urls.set(`ow:t${i}`, expandTemplate(tpl.template, target))
      items.push({ id: `ow:t${i}`, label: tpl.name })
    })
    const run = (id: string): void => {
      if (id === 'ow:default' || id === 'ow:reveal') {
        // 宿主要原生路径（C:\x）；本地 POSIX 形式 /C:/x 先还原。
        void openInApp(displayPath(p), id === 'ow:reveal').then((ok) => {
          if (!ok) fail(new Error(t('ctx.openFailed', { message: displayPath(p) })))
        })
        return
      }
      const url = urls.get(id)
      if (url !== undefined) void launchUrl(opts.api, url).catch(fail)
    }
    return { items, run }
  }

  const removeMany = async (paths: readonly string[]): Promise<void> => {
    const tops = outermost(paths)
    const ok = await askConfirm({
      message: t('files.deleteManyConfirm', { count: tops.length }),
      okLabel: t('files.delete'),
      cancelLabel: t('form.cancel'),
      danger: true
    })
    if (!ok) return
    let removed = 0
    const parents = new Set<string>()
    for (const p of tops) {
      try {
        await opts.api.call('sftpRemove', { hostId: opts.hostId, path: p })
        removed += 1
        parents.add(parentOf(p))
        opts.onRemoved?.(p)
      } catch (err) {
        fail(err)
        break
      }
    }
    for (const d of parents) opts.reloadDir(d)
    if (removed > 0) flash(t('files.deletedMany', { count: removed }))
    opts.onBatchDone?.()
  }

  /** 多选右键：批量菜单。 */
  const openBatch = (e: ReactMouseEvent, paths: readonly string[]): void => {
    const items: MenuItem[] = [
      { id: 'rel', label: t('ctx.copyRel') },
      { id: 'abs', label: t('ctx.copyAbs') },
      ...(opts.sessionId !== undefined ? [{ id: 'ref', label: t('ctx.reference') }] : []),
      { type: 'separator' },
      { id: 'zip', label: t('ctx.zip') },
      { type: 'separator' },
      { id: 'delete', label: t('files.deleteMany', { count: outermost(paths).length }), danger: true }
    ]
    open(e, items, (id) => {
      if (id === 'rel') copyPath(paths.map((p) => relativeTo(opts.root, p)).join('\n'))
      if (id === 'abs') copyPath(paths.map((p) => displayPath(p)).join('\n'))
      if (id === 'ref') void reference(paths)
      if (id === 'zip') void zip(paths)
      if (id === 'delete') void removeMany(paths)
    })
  }

  const pickUpload = (dir: string): void => {
    uploadDir.current = dir
    uploadRef.current?.click()
  }

  const createItems = (): MenuItem[] => [
    { id: 'newFile', label: t('files.newFile') },
    { id: 'newFolder', label: t('files.newFolder') },
    { id: 'upload', label: t('files.uploadHere') }
  ]

  const openFor = (e: ReactMouseEvent, path: string, isDir: boolean): void => {
    const rel = relativeTo(opts.root, path)
    if (!opts.editable) {
      open(e, [{ id: 'rel', label: t('ctx.copyRel') }], () => copyPath(rel))
      return
    }
    const selected = opts.selection?.() ?? []
    if (selected.length > 1 && selected.includes(path)) {
      openBatch(e, selected)
      return
    }
    const dir = isDir ? path : parentOf(path)
    const ow = openWithItems(path)
    const items: MenuItem[] = [
      ...createItems(),
      { type: 'separator' },
      ...(opts.sessionId !== undefined ? [{ id: 'ref', label: t('ctx.reference') }] : []),
      { id: 'openWith', label: t('ctx.openWith'), children: ow.items },
      { type: 'separator' },
      { id: 'rename', label: t('ctx.rename') },
      { id: 'copy', label: t('ctx.copy') },
      { id: 'paste', label: t('ctx.paste'), disabled: !canPaste() },
      ...(isDir ? [{ id: 'zip', label: t('ctx.zip') }] : [{ id: 'download', label: t('files.download') }]),
      { type: 'separator' },
      { id: 'rel', label: t('ctx.copyRel') },
      { id: 'abs', label: t('ctx.copyAbs') },
      { type: 'separator' },
      { id: 'delete', label: t('files.delete'), danger: true }
    ]
    open(e, items, (id) => {
      if (id.startsWith('ow:')) ow.run(id)
      if (id === 'ref') void reference([path])
      if (id === 'zip') void zip([path])
      if (id === 'newFile') void create(dir, 'file')
      if (id === 'newFolder') void create(dir, 'dir')
      if (id === 'upload') pickUpload(dir)
      if (id === 'rename') setRenaming(path)
      if (id === 'copy') {
        remoteClipboard.set({ hostId: opts.hostId, path, isDir })
        flash(t('ctx.copiedItem', { name: baseName(path) }))
      }
      if (id === 'paste') void paste(dir)
      if (id === 'download') startDownload(opts.hostId, path)
      if (id === 'rel') copyPath(rel)
      if (id === 'abs') copyPath(displayPath(path))
      if (id === 'delete') void remove(path, isDir)
    })
  }

  const openForRoot = (e: ReactMouseEvent): void => {
    if (!opts.editable) return
    open(
      e,
      [
        ...createItems(),
        { type: 'separator' },
        { id: 'paste', label: t('ctx.paste'), disabled: !canPaste() },
        { type: 'separator' },
        { id: 'abs', label: t('ctx.copyAbs') }
      ],
      (id) => {
        if (id === 'newFile') void create(opts.root, 'file')
        if (id === 'newFolder') void create(opts.root, 'dir')
        if (id === 'upload') pickUpload(opts.root)
        if (id === 'paste') void paste(opts.root)
        if (id === 'abs') copyPath(displayPath(opts.root))
      }
    )
  }

  const submitRename = async (path: string, name: string): Promise<void> => {
    const trimmed = name.trim()
    const old = baseName(path)
    if (trimmed === '' || trimmed === old) {
      setRenaming(null)
      return
    }
    const problem = nameProblem(trimmed)
    if (problem !== undefined) {
      setRenaming(null)
      fail(new Error(problem))
      return
    }
    try {
      const r = await opts.api.call('sftpRename', { hostId: opts.hostId, path, name: trimmed })
      setRenaming(null)
      opts.reloadDir(parentOf(path))
      opts.onRenamed?.(path, r.path)
    } catch (err) {
      // 失败时收起输入框并显示原因（输入框只提交一次，留着也无法再提交）。
      setRenaming(null)
      fail(err)
    }
  }

  const node = (
    <>
      {menuNode}
      <input
        ref={uploadRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          const files = [...(e.target.files ?? [])]
          e.target.value = ''
          if (files.length > 0) void uploadFiles(files)
        }}
      />
    </>
  )

  return { node, openFor, openForRoot, renaming, submitRename, cancelRename: () => setRenaming(null), uploadInto }
}
/** 行内重命名输入框：回车提交、Esc 取消、失焦提交；打开时选中不含扩展名的部分。 */
export function RenameInput(props: { initial: string; onSubmit(name: string): void; onCancel(): void; paddingLeft: number }) {
  const ref = useRef<HTMLInputElement>(null)
  const done = useRef(false)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    el.focus()
    const dot = props.initial.lastIndexOf('.')
    el.setSelectionRange(0, dot > 0 ? dot : props.initial.length)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const finish = (submit: boolean): void => {
    if (done.current) return
    done.current = true
    if (submit) props.onSubmit(ref.current?.value ?? props.initial)
    else props.onCancel()
  }
  return (
    <div className="dshws-rename" style={{ paddingLeft: props.paddingLeft }}>
      <input
        ref={ref}
        className="dshws-input dshws-rename-input"
        defaultValue={props.initial}
        spellCheck={false}
        onKeyDown={(e) => {
          if (e.key === 'Enter') finish(true)
          if (e.key === 'Escape') {
            e.stopPropagation()
            finish(false)
          }
        }}
        onBlur={() => finish(true)}
      />
    </div>
  )
}
