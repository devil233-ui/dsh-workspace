/*
 * @Description: 右侧栏文件查看器 —— 远程（SFTP）与本机文件统一：按扩展名分派 Monaco / Markdown / HTML / 图片 / 音视频 / file-viewer / 仅下载
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/RemoteFileTab.tsx
 *
 * 分派规则见 viewers/dispatch.ts（文件关联、大文件阈值、HTML 沙箱等偏好的默认值在 viewers/defaults.ts）。
 * 读写通道见 viewers/io.ts：远程走 SFTP；本机任意路径可读、写入只限当前会话工作区。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { RemoteCallError } from '../api.js'
import { ERROR_CODES, LOCAL_ANY_HOST } from '../../wire/contract.js'
import type { ReadResult } from '../../wire/dto.js'
import { CodeEditor } from '../files/CodeEditor.js'
import { LOCAL_HOST_PREFIX, displayPath, isInsideLocal, toLocalPosix, type RemoteIndex } from './remote-index.js'
import { isDesktopRenderer } from '../host-url.js'
import { isLight, resolveColor } from '../terminal/theme.js'
import { FileIcon, IconButton, IconClose, IconDownload, IconRefresh } from './ui.js'
import { fileIO } from '../viewers/io.js'
import { initialViewMode, planViewer } from '../viewers/dispatch.js'
import { getViewerPrefs, subscribeViewerPrefs } from '../viewers/prefs.js'
import { folderAction, probeDirectory, type FolderAction } from './folder-redirect.js'
import { revealParams } from './open-in-sidebar.js'
import { openInApp, openInAppAvailable } from './host-bridge.js'
import { copyText } from './ContextMenu.js'
import { MarkdownPreview } from '../viewers/MarkdownPreview.js'
import { HtmlPreview } from '../viewers/HtmlPreview.js'
import { DownloadPane, FileViewerPane, ImagePane, MediaPane } from '../viewers/BinaryPanes.js'

/** 宿主标签自身的动作（dsh-client-ui-sidebar-right 的 tabActions；旧宿主没有）。 */
export interface SidebarTabActions {
  /** replaceTab: true = 在本标签所在窗格原位替换本标签（宿主 place() 把它换成本标签 id）。 */
  openTab?(kind: string, options?: { replaceTab?: boolean; params?: unknown; revealIfOpened?: boolean }): void
  close?(): void
}

export interface SidebarTabInfo {
  tab: {
    id: string
    kind: string
    title: string
    contentId: string
    visible?: boolean
    navigation?: { params?: unknown; revision?: number }
    actions?: SidebarTabActions
  }
}

export interface SidebarBodyProps {
  t: Translate
  api: WorkspaceApi
  index: RemoteIndex
  /** 在右侧栏打开一个文件地址。 */
  openResource(address: string): void
  sessionId: string
  /** 右侧栏标签才有；会话顶部标签没有。 */
  useTabInfo?(): SidebarTabInfo
  /** 「文件管理」标签的 kind（接管宿主「文件」侧栏时是 files）；未启用返回 undefined。查看器遇到文件夹时用。 */
  folderFilesKind?(): string | undefined
  /** 旧宿主没有 tab.actions 时打开「文件管理」的退路。 */
  openFilesTab?(kind: string, params: Record<string, unknown>): void
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 与本插件同一个版本号的索引刷新计数：远程工作区列表更新后重新解析地址。 */
function useIndexVersion(index: RemoteIndex): number {
  const [v, setV] = useState(0)
  useEffect(() => index.subscribe(() => setV((x) => x + 1)), [index])
  return v
}

function baseName(p: string): string {
  return p.slice(p.lastIndexOf('/') + 1) || p
}

/** 打开文件时带的导航参数（dshWorkspace.openFile 的 line / mode，经 sidebarRight.openResource 的 params 传入）。 */
export interface FileNav {
  line?: number
  mode?: 'preview' | 'edit'
  /** 这次导航的身份：宿主 navigation.revision，旧宿主退回 params.nonce。 */
  key: string
}

/** 从标签导航里取 line / mode；都没有返回 undefined。 */
export function navOf(navigation: { params?: unknown; revision?: number } | undefined): FileNav | undefined {
  const p = navigation?.params as { line?: unknown; mode?: unknown; nonce?: unknown } | undefined
  if (p === undefined || p === null || typeof p !== 'object') return undefined
  const line = typeof p.line === 'number' && Number.isInteger(p.line) && p.line > 0 ? p.line : undefined
  const mode = p.mode === 'preview' || p.mode === 'edit' ? p.mode : undefined
  if (line === undefined && mode === undefined) return undefined
  return {
    ...(line !== undefined ? { line } : {}),
    ...(mode !== undefined ? { mode } : {}),
    key: `${navigation?.revision ?? ''}|${typeof p.nonce === 'number' ? p.nonce : ''}`
  }
}

/**
 * 右侧栏文件标签：解析地址后交给查看器（规则见 viewerTargetOf）；目标是文件夹时改开「文件管理」（见 folder-redirect.ts）。
 */
export function RemoteFileTab(props: SidebarBodyProps) {
  const { t, api, index } = props
  const info = (props.useTabInfo as () => SidebarTabInfo)()
  useIndexVersion(index)
  const address = info.tab.contentId
  const nav = navOf(info.tab.navigation)
  const target = viewerTargetOf(index, address, props.sessionId, t)
  // 先探测目标是不是文件夹（聊天链接 / openFile 打开前宿主不知道类型），探测结束前不挂载查看器，避免闪出「只能预览普通文件」。
  const probe = useDirectoryProbe(api, target?.hostId, target?.path)
  if (target === undefined) return <div className="dshws-side-note">{t('side.notRemote')}</div>
  if (probe === 'pending') return <div className="dshws-tree-note">{t('files.loading')}</div>
  if (probe === 'dir') {
    // 「文件管理」显示的是标签所在会话的工作区：远程目标还要求是同一台主机，否则无法在那棵树里定位。
    const ws = index.workspaceFor(props.sessionId)
    const root = ws === undefined || ws.local !== target.local || (!ws.local && ws.hostId !== target.hostId) ? undefined : ws.remotePath
    return (
      <FolderRedirect
        key={`${target.hostId}:${target.path}`}
        t={t}
        tab={info.tab}
        path={target.path}
        local={target.local}
        action={folderAction(root, target.path, target.local)}
        filesKind={props.folderFilesKind?.()}
        openFilesTab={props.openFilesTab}
      />
    )
  }
  return (
    <RemoteFileViewer
      key={`${target.hostId}:${target.path}`}
      nav={nav}
      t={t}
      api={api}
      hostId={target.hostId}
      remotePath={target.path}
      workspaceTitle={target.title}
      workspaceRoot={target.root}
    />
  )
}

interface ViewerTarget {
  hostId: string
  path: string
  title: string
  root: string
  local: boolean
}

/**
 * 地址 → 查看器目标。
 * - 远程工作区会话（或远程占位目录）里的地址 → 远程文件；
 * - 其余本机地址 → 本机文件：在当前（地址所属 / 标签所在）会话工作区内的可保存，工作区外只读。
 */
function viewerTargetOf(index: RemoteIndex, address: string, tabSession: string, t: Translate): ViewerTarget | undefined {
  const resolved = index.resolveAddress(address)
  if (resolved !== undefined) {
    return { hostId: resolved.workspace.hostId, path: resolved.remotePath, title: resolved.workspace.title, root: resolved.workspace.remotePath, local: false }
  }
  const local = index.resolveLocalAddress(address)
  if (local === undefined) return undefined
  // 可写的会话：地址自带的会话，或（absolute 地址）标签所在的会话；文件必须在它的 cwd 内。
  const sessionId = local.sessionId ?? tabSession
  const cwd = local.cwd ?? index.sessionCwd(sessionId)
  const inside = cwd !== undefined && cwd !== '' && index.bySession(sessionId) === undefined && isInsideLocal(cwd, local.path)
  return {
    hostId: inside ? `${LOCAL_HOST_PREFIX}${sessionId}` : LOCAL_ANY_HOST,
    path: local.path,
    title: inside ? baseName(toLocalPosix(cwd as string)) : t('viewer.localFile'),
    root: inside ? toLocalPosix(cwd as string) : local.path.slice(0, Math.max(local.path.lastIndexOf('/'), 1)),
    local: true
  }
}

/** 探测超时：后台卡住时不能让查看器一直停在「加载中」，超时按文件处理（与探测失败相同）。 */
const PROBE_TIMEOUT_MS = 4000

type Probe = 'pending' | 'dir' | 'file'

function useDirectoryProbe(api: WorkspaceApi, hostId: string | undefined, path: string | undefined): Probe {
  const key = hostId === undefined || path === undefined ? undefined : `${hostId}\n${path}`
  const [result, setResult] = useState<{ key: string; value: Probe } | undefined>(undefined)
  useEffect(() => {
    if (hostId === undefined || path === undefined || key === undefined) return
    let alive = true
    const timer = setTimeout(() => alive && setResult({ key, value: 'file' }), PROBE_TIMEOUT_MS)
    void probeDirectory(api, hostId, path).then((dir) => {
      clearTimeout(timer)
      if (alive) setResult((prev) => (prev?.key === key ? prev : { key, value: dir ? 'dir' : 'file' }))
    })
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [api, hostId, path, key])
  // 地址变了（同一标签被导航到别的目标）：旧结果作废，重新探测。
  return result !== undefined && result.key === key ? result.value : 'pending'
}

interface FolderRedirectProps {
  t: Translate
  tab: SidebarTabInfo['tab']
  path: string
  local: boolean
  action: FolderAction
  filesKind: string | undefined
  openFilesTab?(kind: string, params: Record<string, unknown>): void
}

/**
 * 目标是文件夹：能在「文件管理」里定位就原位替换本标签（tab.actions.openTab + replaceTab，同一窗格、同一位置，无闪烁）；
 * 不在工作区内 / 文件管理未启用时提示，并提供「在系统文件管理器中打开」（仅本机且宿主支持）与「复制路径」。
 */
function FolderRedirect(props: FolderRedirectProps) {
  const { t, tab, action, filesKind } = props
  const shown = displayPath(props.path)
  const redirect = action.kind === 'reveal' && filesKind !== undefined
  const done = useRef(false)
  const [failed, setFailed] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [osOpen, setOsOpen] = useState(false)

  useEffect(() => {
    if (!redirect || done.current || action.kind !== 'reveal' || filesKind === undefined) return
    done.current = true
    const params = revealParams(action.target, true, Date.now())
    try {
      if (typeof tab.actions?.openTab === 'function') {
        tab.actions.openTab(filesKind, { replaceTab: true, params })
      } else if (props.openFilesTab !== undefined) {
        // 旧宿主：没有原位替换，只能另开「文件管理」；本标签留着提示（也关不掉自己）。
        props.openFilesTab(filesKind, params)
      } else {
        setFailed(true)
      }
    } catch {
      setFailed(true)
    }
    // 只在挂载时执行一次：标签被替换后本组件随之卸载
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (!props.local) return
    let live = true
    void openInAppAvailable().then((ok) => live && setOsOpen(ok))
    return () => {
      live = false
    }
  }, [props.local])

  if (redirect && !failed) return <div className="dshws-tree-note">{t('side.folderOpened')}</div>
  const reason = action.kind === 'outside' ? t('side.folderOutside') : t('side.folderNoTree')
  return (
    <div className="dshws-side">
      <div className="dshws-subbar dshws-mono" title={shown}>
        {shown}
      </div>
      <div className="dshws-tree-note">{reason}</div>
      <div className="dshws-tree-note">
        {props.local && osOpen ? (
          <button
            type="button"
            className="dshws-link-btn"
            onClick={() => void openInApp(shown).then((ok) => setNotice(ok ? null : t('side.folderOsFailed')))}
          >
            {t('side.folderOpenInOs')}
          </button>
        ) : null}
        <button
          type="button"
          className="dshws-link-btn"
          onClick={() => void copyText(shown).then(() => setNotice(t('ctx.copiedPath')), () => setNotice(t('side.folderCopyFailed')))}
        >
          {t('side.folderCopyPath')}
        </button>
      </div>
      {notice !== null ? <div className="dshws-tree-note">{notice}</div> : null}
    </div>
  )
}

export interface RemoteFileViewerProps {
  t: Translate
  api: WorkspaceApi
  /** 远程主机 id；本机为 local:<会话>（工作区内，可保存）或 local:*（只读）。 */
  hostId: string
  /** 线上路径（远程绝对路径 / 本地 POSIX 形式）。 */
  remotePath: string
  workspaceTitle: string
  /** 工作区根（预览内联时 / 开头的引用以它为基准）；缺省用文件所在目录。 */
  workspaceRoot?: string
  /** 嵌在分栏右侧时提供：显示关闭按钮。 */
  onClose?(): void
  /** 保存成功后通知（Git 面板据此刷新改动列表）。 */
  onSaved?(): void
  /** 外部要求的定位行 / 打开方式（见 navOf）。 */
  nav?: FileNav
}

function useViewerPrefs() {
  const [prefs, setPrefs] = useState(getViewerPrefs)
  useEffect(() => subscribeViewerPrefs(() => setPrefs(getViewerPrefs())), [])
  return prefs
}

type Mode = 'preview' | 'code'

/** 文件查看 / 编辑器（右侧栏标签与分栏右侧共用）。 */
export function RemoteFileViewer(props: RemoteFileViewerProps) {
  const { t, api, hostId, remotePath } = props
  const io = useMemo(() => fileIO(api, hostId, remotePath), [api, hostId, remotePath])
  const prefs = useViewerPrefs()
  const name = baseName(remotePath)
  const plan = useMemo(() => planViewer(name, prefs), [name, prefs])
  const desktop = isDesktopRenderer()
  const dark = !isLight(resolveColor('var(--dsw-alias-bg-layer-1)', '#ffffff'))
  const root = props.workspaceRoot ?? (remotePath.slice(0, remotePath.lastIndexOf('/')) || '/')

  const [chosen, setChosen] = useState<Mode | null>(null)
  // 外部导航（openFile 带 line / mode）：每次新的导航切一次视图；指定了行号就进代码视图才能定位。
  const navKey = props.nav?.key
  const navLine = props.nav?.line
  const navMode = props.nav?.mode
  useEffect(() => {
    if (navKey === undefined) return
    if (navMode === 'preview' && navLine === undefined) setChosen('preview')
    else setChosen('code')
  }, [navKey, navLine, navMode])
  let mode: Mode = chosen ?? initialViewMode(plan)
  if (!plan.textual) mode = 'preview'

  const needsText = plan.viewer === 'monaco' || plan.viewer === 'markdown' || plan.viewer === 'html' || mode === 'code'
  const [file, setFile] = useState<ReadResult | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [editorKey, setEditorKey] = useState(0)
  const [conflict, setConflict] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setFile(await io.readText())
      setDraft(null)
      setEditorKey((k) => k + 1)
      setConflict(null)
    } catch (err) {
      setError(messageOf(err))
    } finally {
      setLoading(false)
    }
  }, [io])

  useEffect(() => {
    if (needsText && file === null) void load()
  }, [load, needsText, file])

  const save = async (value: string, force = false): Promise<void> => {
    if (file === null) return
    try {
      const saved = await io.write(value, force ? undefined : file.mtime)
      // 内容一并更新：预览直接用它渲染，保存后切到预览看到的就是新内容。
      setFile({ ...file, content: value, mtime: saved.mtime, size: saved.size })
      setDraft(value)
      setConflict(null)
      setNonce((n) => n + 1)
      props.onSaved?.()
    } catch (err) {
      if (err instanceof RemoteCallError && err.code === ERROR_CODES.conflict) setConflict(value)
      else setError(messageOf(err))
      throw err
    }
  }

  const editable = file !== null && !file.binary && !file.truncated && !file.lossy && io.writable
  const current = draft ?? file?.content ?? ''
  const dirty = file !== null && draft !== null && draft !== file.content
  const showsEditor = mode === 'code'

  const editor =
    file === null ? null : (
      <CodeEditor
        // 导航身份进 key：同一文件再次带行号打开时重建编辑器并重新定位。
        key={`${remotePath}#${editorKey}#${mode}#${navKey ?? ''}`}
        t={t}
        path={remotePath}
        line={navLine}
        content={current}
        readOnly={!editable}
        onDirtyChange={() => undefined}
        onChange={setDraft}
        fetchAsset={(assetName, i) => api.call('editorAsset', { name: assetName, index: i })}
        onSave={(value) => save(value)}
        registerSave={() => undefined}
      />
    )

  // Markdown 与 HTML 等可预览的文本共用同一组「预览 / 代码」切换，样式一致。
  const segments: Array<[Mode, string]> =
    plan.textual && plan.viewer !== 'monaco'
      ? [['preview', t('side.preview')], ['code', t('side.code')]]
      : []

  let body: ReactNode
  if (needsText && file === null) {
    body = loading || error === null ? <div className="dshws-tree-note">{t('files.loading')}</div> : null
  } else if (needsText && file !== null && file.binary) {
    body = <DownloadPane t={t} io={io} reason="binary" />
  } else if (mode === 'code') {
    body = editor
  } else if (plan.viewer === 'markdown') {
    // 预览渲染当前内容（含代码视图里未保存的草稿），切回预览即可看到改动效果。
    body = (
      <MarkdownPreview
        t={t}
        io={io}
        content={current}
        path={remotePath}
        root={root}
        inline={desktop}
        dark={dark}
        source={displayPath(remotePath)}
        nonce={nonce}
      />
    )
  } else if (plan.viewer === 'html') {
    body = <HtmlPreview t={t} io={io} content={file?.content ?? null} path={remotePath} root={root} inline={desktop} nonce={nonce} />
  } else if (plan.viewer === 'file-viewer') {
    body = <FileViewerPane key={nonce} t={t} io={io} name={name} plan={plan} dark={dark} nonce={nonce} />
  } else if (plan.viewer === 'image') {
    body = <ImagePane t={t} io={io} name={name} nonce={nonce} />
  } else if (plan.viewer === 'media') {
    body = <MediaPane t={t} io={io} ext={plan.ext} nonce={nonce} />
  } else if (plan.viewer === 'download') {
    body = <DownloadPane t={t} io={io} reason="format" />
  } else {
    body = editor
  }

  return (
    <div className="dshws-side">
      <div className="dshws-toolbar">
        <FileIcon name={name} />
        <span className="dshws-toolbar-title" title={`${props.workspaceTitle}: ${displayPath(remotePath)}`}>
          {name}
          {dirty ? <span className="dshws-dirty" title={t('editor.saveHint')}> ●</span> : null}
        </span>
        {segments.length > 0 ? (
          <span className="dshws-side-seg">
            {segments.map(([m, label]) => (
              <button key={m} type="button" data-active={mode === m} onClick={() => setChosen(m)}>
                {label}
              </button>
            ))}
          </span>
        ) : null}
        {showsEditor && editable ? (
          <button type="button" className="dshws-link-btn" disabled={!dirty} onClick={() => void save(current).catch(() => undefined)}>
            {t('form.save')}
          </button>
        ) : null}
        <IconButton title={t('viewer.download')} onClick={() => io.download()}>
          <IconDownload />
        </IconButton>
        <IconButton
          title={t('editor.reload')}
          onClick={() => {
            setNonce((n) => n + 1)
            if (needsText) void load()
          }}
        >
          <IconRefresh />
        </IconButton>
        {props.onClose !== undefined ? (
          <IconButton title={t('common.close')} onClick={props.onClose}>
            <IconClose />
          </IconButton>
        ) : null}
      </div>
      <div className="dshws-subbar dshws-mono" title={displayPath(remotePath)}>
        {displayPath(remotePath)}
      </div>
      {conflict !== null ? (
        <div className="dshws-side-banner" data-tone="warn">
          {t('editor.conflictTitle')}
          <button type="button" className="dshws-link-btn" onClick={() => void save(conflict, true).catch(() => undefined)}>
            {t('editor.overwrite')}
          </button>
          <button type="button" className="dshws-link-btn" onClick={() => void load()}>
            {t('editor.reload')}
          </button>
        </div>
      ) : null}
      {error !== null ? (
        <div className="dshws-tree-note" data-tone="error">
          {error}
        </div>
      ) : null}
      {showsEditor && file !== null && !file.binary ? (
        <>
          {file.truncated ? <div className="dshws-tree-note" data-tone="warn">{t('side.truncated')}</div> : null}
          {file.lossy ? <div className="dshws-tree-note" data-tone="warn">{t('editor.lossy')}</div> : null}
          {!io.writable ? <div className="dshws-tree-note">{t('viewer.readOnlyOutside')}</div> : null}
        </>
      ) : null}
      {body}
    </div>
  )
}
