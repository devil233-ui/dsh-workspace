/*
 * @Description: 右侧栏「文件管理」标签 —— 当前工作区（远程经 SFTP / 本地直接读写）的文件树，点文件在右侧栏打开；右键菜单（重命名 / 复制 / 粘贴 / 复制路径）
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/RemoteFilesTab.tsx
 *
 * 文件树增强（方案 3.4）：
 * - 文件名搜索（sftpSearch：远程 find / 本机遍历），结果点文件打开、点目录在树中定位；
 * - 自动刷新：每 3 秒批量取展开目录的 mtime（sftpDirStamps），变了的目录静默重载；页面隐藏 / 标签不可见时暂停，偏好 autoRefresh 可关；
 * - Git 状态：文件 M/A/D/R/U/?? 徽标、含改动的目录着色（非 git 仓库静默不显示），随自动刷新 / 手动刷新更新；
 * - 多选：Ctrl/⌘ 点选、Shift 连选（tree-select.ts），右键批量菜单见 file-menu.tsx；
 * - 拖放上传：拖到目录行 = 该目录，拖到文件行 = 它所在目录，拖到空白处 = 根目录（窄屏不提供拖放）。
 */
import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent as ReactDragEvent } from 'react'
import type { RemoteEntry, SearchResult } from '../../wire/dto.js'
import type { GitStatus } from '../../git/parse.js'
import { DIR_STAMPS_MAX } from '../../wire/open-with.js'
import { displayPath, localSessionAddress, revealPlan, sessionFileAddress } from './remote-index.js'
import { RemoteFileViewer, type SidebarBodyProps } from './RemoteFileTab.js'
import { Split } from './Split.js'
import { NOTE_HEIGHT, ROW_HEIGHT, VirtualList } from './VirtualList.js'
import { isOutdatedHostError, useLocalSupport } from './host-support.js'
import { RenameInput, useRemoteFileMenu } from './file-menu.js'
import { relativeTo, showFloat } from './ContextMenu.js'
import { EmptyState, FileIcon, IconButton, IconChevron, IconClose, IconEye, IconFile, IconFolder, IconRefresh, IconSearch } from './ui.js'
import { EMPTY_SELECTION, clickSelect, pruneSelection, type TreeSelection } from './tree-select.js'
import { NO_DECORATIONS, buildDecorations, sameDecorations, type GitDecorations, type GitMark } from './git-decor.js'
import { DropTooManyError, isFileDrag, takeDrop } from './drop-upload.js'
import { useSidebarPrefs } from '../sidebar-prefs.js'
import { useNarrow } from '../narrow.js'

interface DirState {
  loading: boolean
  entries?: RemoteEntry[]
  error?: string
}

/** 标签 id → 已处理的「显示文件位置」导航身份（见下方定位 effect）。 */
const handledReveals = new Map<string, string>()

/** 自动刷新与 Git 状态的轮询间隔。 */
const STAMP_INTERVAL_MS = 3000
const GIT_INTERVAL_MS = 10_000

function parentOf(p: string): string {
  const i = p.lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

export function RemoteFilesTab(props: SidebarBodyProps) {
  const { t, api, index, sessionId } = props
  const [, setVersion] = useState(0)
  useEffect(() => index.subscribe(() => setVersion((v) => v + 1)), [index])
  const workspace = index.workspaceFor(sessionId)
  // 升级后只刷新了页面、宿主端还是旧版：本地会话直接提示重启，而不是报「主机不存在：local:…」。
  const support = useLocalSupport(api, workspace?.local === true)
  // 依赖用字符串而不是 workspace 对象：对象换了但内容没变时不重载。
  const hostId = workspace?.hostId
  const root = workspace?.remotePath
  const prefs = useSidebarPrefs()
  const narrow = useNarrow()
  const [dirs, setDirs] = useState<Record<string, DirState>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [showHidden, setShowHidden] = useState(false)
  const [selected, setSelected] = useState<string | null>(null)
  /** 多选（与右侧打开的文件 selected 无关）。ref 供右键菜单同步读取。 */
  const [sel, setSelState] = useState<TreeSelection>(EMPTY_SELECTION)
  const selRef = useRef<TreeSelection>(EMPTY_SELECTION)
  const setSel = (next: TreeSelection): void => {
    selRef.current = next
    setSelState(next)
  }
  /** 「显示文件位置」定位到的文件：只高亮并滚动过去，不打开（窄面板里打开会盖住列表）。 */
  const [focus, setFocus] = useState<{ path: string; nonce: number } | null>(null)
  const [decor, setDecor] = useState<GitDecorations>(NO_DECORATIONS)
  const [search, setSearch] = useState<{ open: boolean; query: string }>({ open: false, query: '' })
  const [found, setFound] = useState<{ query: string; loading: boolean; result?: SearchResult; error?: string } | null>(null)
  /** 拖放上传的目标目录（高亮用）。 */
  const [dropDir, setDropDir] = useState<string | null>(null)
  const wideRef = useRef(false)
  // 导航参数（交付卡片「显示文件位置」经 sidebarRight.openTab 传入）；会话顶部标签没有 useTabInfo。
  const tabInfo = props.useTabInfo?.()
  const params = tabInfo?.tab.navigation?.params as { reveal?: unknown; nonce?: unknown; expand?: unknown } | undefined
  const reveal = typeof params?.reveal === 'string' ? params.reveal : undefined
  // expand：定位的是文件夹（open_in_sidebar 打开文件夹），同时把它展开。
  const revealExpand = params?.expand === true
  // 这次导航的身份：宿主每次 navigate 递增 revision；旧宿主没有时退回 openTab 传入的 nonce。
  const revealKey = `${tabInfo?.tab.navigation?.revision ?? ''}|${typeof params?.nonce === 'number' ? params.nonce : ''}`
  const tabId = tabInfo?.tab.id
  // 标签在后台（右侧栏切到别的标签）时不轮询；会话顶部标签没有这个信息，按可见处理。
  const tabVisible = tabInfo?.tab.visible !== false

  /**
   * 打开文件：够宽就在本页右侧打开；右侧栏里的窄面板维持原来的「新开一个文件标签」；
   * 会话顶部标签（没有标签信息）窄时也在本页打开（整页覆盖列表，✕ 返回）。
   */
  const openFile = (path: string): void => {
    // 用户自己点开文件后，定位高亮就不再有意义（否则会同时出现两个高亮行）。
    setFocus(null)
    // 本地文件也用会话范围地址（与宿主聊天里的文件链接同一写法，见 localSessionAddress）：
    // 由本插件的查看器认领；旧的 absolute 地址在卸载 better-sidebar 后曾无人认领。
    if (!wideRef.current && props.useTabInfo !== undefined) {
      props.openResource(workspace?.local === true ? localSessionAddress(sessionId, index.sessionCwd(sessionId), path) : sessionFileAddress(sessionId, path))
    }
    else setSelected(path)
  }

  const loadDir = useCallback(
    async (dir: string) => {
      if (hostId === undefined) return
      setDirs((d) => ({ ...d, [dir]: { ...d[dir], loading: true } }))
      try {
        const r = await api.call('sftpList', { hostId, path: dir })
        setDirs((d) => ({ ...d, [dir]: { loading: false, entries: r.entries } }))
      } catch (err) {
        setDirs((d) => ({ ...d, [dir]: { loading: false, error: err instanceof Error ? err.message : String(err) } }))
      }
    },
    [api, hostId]
  )

  useEffect(() => {
    if (root !== undefined) void loadDir(root)
  }, [loadDir, root])

  /** 在树中定位：展开到目标所在目录（expandSelf 时连目标本身一起展开），高亮并滚动过去。 */
  const revealPath = useCallback(
    (target: string, expandSelf: boolean): boolean => {
      if (root === undefined) return false
      const plan = revealPlan(root, target)
      if (plan === undefined) return false
      // 用规范化后的定位路径（plan.target）：链接里的 ..、重复斜杠、盘符大小写都会让原样字符串对不上树里的行。
      const list = expandSelf ? [...plan.dirs, plan.target] : plan.dirs
      setExpanded((cur) => new Set([...cur, ...list]))
      for (const dir of [root, ...list]) void loadDir(dir)
      // 目标在隐藏目录里时打开「显示隐藏文件」（否则目标行不渲染）；用户随时可以再关掉。
      if (plan.hidden) setShowHidden(true)
      setFocus({ path: plan.target, nonce: Date.now() })
      return true
    },
    [root, loadDir]
  )

  // 定位：展开从根到文件所在目录的每一级并（重新）加载 —— 文件可能刚由 Agent 创建，旧列表里还没有它。
  // 宿主把导航参数保留到标签关闭：组件重新挂载（切会话回来、面板重建）时不能再执行一遍，
  // 所以按「标签 + 导航身份」记下已处理的，记录放在模块级（组件状态会随重新挂载丢失）。
  useEffect(() => {
    if (reveal === undefined || root === undefined || tabId === undefined) return
    if (handledReveals.get(tabId) === revealKey) return
    if (revealPlan(root, reveal) === undefined) return
    handledReveals.set(tabId, revealKey)
    revealPath(reveal, revealExpand)
  }, [reveal, revealKey, revealExpand, tabId, root, revealPath])

  // ---------------------------------------------------------------- Git 状态装饰

  const gitRun = useRef<() => void>(() => undefined)
  useEffect(() => {
    if (hostId === undefined || root === undefined || !tabVisible) return
    let live = true
    let notRepo = false
    let inflight = false
    const run = async (): Promise<void> => {
      if (inflight || document.visibilityState !== 'visible') return
      inflight = true
      try {
        const s = (await api.call('git', { hostId, root, op: 'status' })) as GitStatus | { isRepo: false }
        if (!live) return
        notRepo = !s.isRepo
        const next = s.isRepo ? buildDecorations(root, s.files) : NO_DECORATIONS
        setDecor((cur) => (sameDecorations(cur, next) ? cur : next))
      } catch {
        // 没装 git、远程未登记等：静默不显示装饰。
        if (live) setDecor(NO_DECORATIONS)
      } finally {
        inflight = false
      }
    }
    gitRun.current = () => void run()
    void run()
    // 只在开启自动刷新时轮询（远程每次都要经 SSH 执行一次 git status）；非仓库不再轮询，手动刷新时再查。
    const timer = prefs.autoRefresh
      ? setInterval(() => {
          if (!notRepo) void run()
        }, GIT_INTERVAL_MS)
      : undefined
    const onFocus = (): void => {
      if (prefs.autoRefresh && !notRepo) void run()
    }
    window.addEventListener('focus', onFocus)
    return () => {
      live = false
      gitRun.current = () => undefined
      if (timer !== undefined) clearInterval(timer)
      window.removeEventListener('focus', onFocus)
    }
  }, [api, hostId, root, tabVisible, prefs.autoRefresh])

  // ---------------------------------------------------------------- 自动刷新（目录 mtime 轮询）

  const dirsRef = useRef(dirs)
  dirsRef.current = dirs
  const expandedRef = useRef(expanded)
  expandedRef.current = expanded
  useEffect(() => {
    if (!prefs.autoRefresh || hostId === undefined || root === undefined || !tabVisible) return
    let live = true
    let busy = false
    // 每次（重新）开始监视都重建基线：暂停期间的变化以第一次比对为准，不会把所有目录都当成「变了」。
    const stamps = new Map<string, number | null>()
    const tick = async (): Promise<void> => {
      if (busy || document.visibilityState !== 'visible') return
      busy = true
      try {
        const watch = [root, ...[...expandedRef.current].filter((d) => d !== root && dirsRef.current[d]?.entries !== undefined)].slice(0, DIR_STAMPS_MAX)
        const r = await api.call('sftpDirStamps', { hostId, paths: watch })
        if (!live) return
        let changed = false
        for (const [p, m] of Object.entries(r.stamps)) {
          const prev = stamps.get(p)
          stamps.set(p, m)
          if (prev === undefined || prev === m) continue
          changed = true
          // 目录没了（被删 / 改名）：重载它的父目录，它会从树里消失。
          void loadDir(m === null ? parentOf(p) : p)
        }
        if (changed) gitRun.current()
      } catch {
        /* 宿主旧版本没有 sftpDirStamps、断线等：下一轮再试 */
      } finally {
        busy = false
      }
    }
    void tick()
    const timer = setInterval(() => void tick(), STAMP_INTERVAL_MS)
    return () => {
      live = false
      clearInterval(timer)
    }
  }, [api, hostId, root, tabVisible, prefs.autoRefresh, loadDir])

  // ---------------------------------------------------------------- 搜索

  useEffect(() => {
    const q = search.query.trim()
    if (!search.open || q === '' || hostId === undefined || root === undefined) {
      setFound(null)
      return
    }
    let live = true
    setFound((cur) => ({ query: q, loading: true, ...(cur?.result !== undefined ? { result: cur.result } : {}) }))
    // 防抖：边打字边搜索，停顿 300ms 才发请求（远程每次是一次 find）。
    const timer = setTimeout(() => {
      api.call('sftpSearch', { hostId, root, query: q }).then(
        (result) => live && setFound({ query: q, loading: false, result }),
        (err: unknown) => live && setFound({ query: q, loading: false, error: err instanceof Error ? err.message : String(err) })
      )
    }, 300)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [search.open, search.query, api, hostId, root])

  // ---------------------------------------------------------------- 行

  /** 树里已知的条目（路径 → 是否目录），多选清理与批量引用用。 */
  const known = useMemo(() => {
    const m = new Map<string, boolean>()
    for (const st of Object.values(dirs)) for (const e of st.entries ?? []) m.set(e.path, e.type === 'dir' || e.linkIsDir === true)
    return m
  }, [dirs])

  // 条目被删除 / 改名后从多选里去掉。
  useEffect(() => {
    const next = pruneSelection(selRef.current, (p) => known.has(p))
    if (next !== selRef.current) setSel(next)
  }, [known])

  const menu = useRemoteFileMenu({
    t,
    api,
    hostId: hostId ?? '',
    root: root ?? '/',
    editable: true,
    sessionId,
    selection: () => [...selRef.current.selected],
    isDir: (p) => known.get(p) ?? p === root,
    onBatchDone: () => setSel(EMPTY_SELECTION),
    reloadDir: (dir) => void loadDir(dir),
    onRenamed: (from, to) => {
      // 打开着的文件（或它所在的目录）被改名：跟着换路径。
      setSelected((cur) => (cur === null ? cur : cur === from ? to : cur.startsWith(`${from}/`) ? to + cur.slice(from.length) : cur))
      setExpanded((cur) => new Set([...cur].map((p) => (p === from ? to : p.startsWith(`${from}/`) ? to + p.slice(from.length) : p))))
    },
    onPasted: (dir) => {
      if (dir !== root) setExpanded((cur) => new Set(cur).add(dir))
    },
    onCreatedFile: (path) => openFile(path),
    onRemoved: (path) => {
      setSelected((cur) => (cur !== null && (cur === path || cur.startsWith(`${path}/`)) ? null : cur))
    }
  })

  if (workspace === undefined || root === undefined) {
    return <div className="dshws-side-note">{t('side.noWorkspace')}</div>
  }
  if (support === 'outdated') return <div className="dshws-side-note" data-tone="error">{t('side.localNeedsRestart')}</div>

  const toggle = (dir: string): void => {
    const next = new Set(expanded)
    if (next.has(dir)) next.delete(dir)
    else {
      next.add(dir)
      if (dirs[dir]?.entries === undefined) void loadDir(dir)
    }
    setExpanded(next)
  }

  const refreshAll = (): void => {
    void loadDir(root)
    for (const d of expanded) void loadDir(d)
    gitRun.current()
  }

  /**
   * 把展开着的目录树拍平成行（虚拟滚动只渲染可见的几十行，几千个文件也不卡）。
   * 行的种类：条目 / 正在改名的条目 / 加载中或出错的提示。
   */
  type Row = { kind: 'entry'; entry: RemoteEntry; depth: number } | { kind: 'note'; key: string; text: string; depth: number; tone?: 'error' }
  const rows: Row[] = []
  const walk = (dir: string, depth: number): void => {
    const state = dirs[dir]
    if (state === undefined || (state.loading && state.entries === undefined)) {
      rows.push({ kind: 'note', key: `${dir}#loading`, text: t('files.loading'), depth })
      return
    }
    if (state.error !== undefined) {
      rows.push({ kind: 'note', key: `${dir}#error`, text: isOutdatedHostError(state.error) ? t('side.localNeedsRestart') : state.error, depth, tone: 'error' })
      return
    }
    for (const e of state.entries ?? []) {
      if (!showHidden && e.hidden) continue
      rows.push({ kind: 'entry', entry: e, depth })
      if ((e.type === 'dir' || e.linkIsDir === true) && expanded.has(e.path)) walk(e.path, depth + 1)
    }
  }
  walk(root, 0)
  const rootEmpty = rows.length === 0
  /** 可见条目的顺序（Shift 连选按它计算）。 */
  const order = rows.flatMap((r) => (r.kind === 'entry' ? [r.entry.path] : []))
  const multi = sel.selected.size > 1

  const onRowClick = (ev: { ctrlKey: boolean; metaKey: boolean; shiftKey: boolean }, path: string, isDir: boolean): void => {
    const toggleKey = ev.ctrlKey || ev.metaKey
    setSel(clickSelect(selRef.current, order, path, { toggle: toggleKey, range: ev.shiftKey }))
    // 带修饰键的点击只改选择，不展开 / 打开。
    if (toggleKey || ev.shiftKey) return
    if (isDir) toggle(path)
    else openFile(path)
  }

  const onRowContext = (ev: Parameters<typeof menu.openFor>[0], path: string, isDir: boolean): void => {
    // 右键不在多选里的项：选择换成它（与 VS Code 一致），菜单按单项显示。
    if (!selRef.current.selected.has(path)) setSel({ selected: new Set([path]), anchor: path })
    menu.openFor(ev, path, isDir)
  }

  const markBadge = (mark: GitMark | undefined, isDir: boolean) =>
    mark === undefined ? null : isDir ? <span className="dshws-gdot" data-g={mark} aria-hidden="true" /> : <span className="dshws-gdec" data-g={mark}>{mark}</span>

  const renderRow = (r: Row) => {
    if (r.kind === 'note') {
      return (
        <div className="dshws-tree-note" data-tone={r.tone} title={r.text} style={{ paddingLeft: 12 + r.depth * 14 }}>
          {r.text}
        </div>
      )
    }
    const e = r.entry
    const depth = r.depth
    const isDir = e.type === 'dir' || e.linkIsDir === true
    const open = expanded.has(e.path)
    if (menu.renaming === e.path) {
      return <RenameInput initial={e.name} paddingLeft={6 + depth * 14} onSubmit={(name) => void menu.submitRename(e.path, name)} onCancel={menu.cancelRename} />
    }
    const mark = isDir ? decor.dirs.get(e.path) : decor.files.get(e.path)
    return (
      <button
        type="button"
        className="dshws-row"
        data-ignored={e.ignored}
        data-hidden={e.hidden}
        data-selected={selected === e.path || focus?.path === e.path || (multi && sel.selected.has(e.path))}
        data-git={mark}
        data-drop={dropDir !== null && isDir && dropDir === e.path}
        data-drop-dir={isDir ? e.path : parentOf(e.path)}
        style={{ paddingLeft: 6 + depth * 14 }}
        title={displayPath(e.path)}
        onClick={(ev) => onRowClick(ev, e.path, isDir)}
        onContextMenu={(ev) => onRowContext(ev, e.path, isDir)}
      >
        <span className="dshws-row-caret">{isDir ? <IconChevron size={12} open={open} /> : null}</span>
        {isDir ? <IconFolder open={open} /> : <FileIcon name={e.name} />}
        <span className="dshws-row-name">{e.name}</span>
        {e.linkTarget !== undefined ? <span className="dshws-row-dim">→ {e.linkTarget}</span> : null}
        {markBadge(mark, isDir)}
      </button>
    )
  }

  // ---------------------------------------------------------------- 拖放上传（窄屏不提供）

  const dropTargetOf = (ev: ReactDragEvent): string => {
    const el = (ev.target as HTMLElement | null)?.closest?.('[data-drop-dir]')
    return el?.getAttribute('data-drop-dir') ?? root
  }
  const dnd = narrow
    ? {}
    : {
        onDragOver: (ev: ReactDragEvent) => {
          if (!isFileDrag(ev.dataTransfer)) return
          ev.preventDefault()
          ev.dataTransfer.dropEffect = 'copy'
          const dir = dropTargetOf(ev)
          if (dir !== dropDir) setDropDir(dir)
        },
        onDragLeave: (ev: ReactDragEvent) => {
          // 只在真正离开列表区域时清除（在子元素间移动也会触发 dragleave）。
          if (!(ev.currentTarget as HTMLElement).contains(ev.relatedTarget as Node | null)) setDropDir(null)
        },
        onDrop: (ev: ReactDragEvent) => {
          if (!isFileDrag(ev.dataTransfer)) return
          ev.preventDefault()
          const dir = dropTargetOf(ev)
          setDropDir(null)
          const collect = takeDrop(ev.dataTransfer)
          void collect().then(
            (items) => {
              if (items.length === 0) return
              if (dir !== root) setExpanded((cur) => new Set(cur).add(dir))
              return menu.uploadInto(dir, items)
            },
            (err: unknown) => showFloat(err instanceof DropTooManyError ? t('files.dropTooMany', { count: err.message }) : err instanceof Error ? err.message : String(err), 'error')
          )
        }
      }

  // ---------------------------------------------------------------- 搜索结果

  type Hit = { path: string; type: 'dir' | 'file' }
  const hits: Hit[] = found?.result?.matches ?? []
  const searchNote =
    found === null
      ? null
      : found.error !== undefined
        ? found.error
        : found.loading && found.result === undefined
          ? t('side.searching')
          : hits.length === 0
            ? t('side.searchEmpty')
            : found.result?.timedOut === true
              ? t('side.searchTimedOut')
              : found.result?.truncated === true
                ? t('side.searchTruncated', { count: hits.length })
                : null
  const renderHit = (h: Hit) => {
    const name = h.path.slice(h.path.lastIndexOf('/') + 1)
    const dir = relativeTo(root, parentOf(h.path))
    const isDir = h.type === 'dir'
    const mark = isDir ? decor.dirs.get(h.path) : decor.files.get(h.path)
    return (
      <button
        type="button"
        className="dshws-row dshws-hit"
        data-selected={selected === h.path}
        data-git={mark}
        style={{ paddingLeft: 10 }}
        title={displayPath(h.path)}
        onClick={() => {
          if (isDir) {
            // 目录：退出搜索，在树中展开并定位。
            setSearch({ open: false, query: search.query })
            revealPath(h.path, true)
          } else {
            openFile(h.path)
            // 同时在树里定位（关闭搜索后就能看到它的位置）。
            revealPath(h.path, false)
          }
        }}
        onContextMenu={(ev) => onRowContext(ev, h.path, isDir)}
      >
        {isDir ? <IconFolder /> : <FileIcon name={name} />}
        <span className="dshws-row-name">{name}</span>
        <span className="dshws-row-dim">{dir === '.' ? '' : dir}</span>
        {markBadge(mark, isDir)}
      </button>
    )
  }

  const list = (
    <div
      className="dshws-side"
      data-drop={dropDir === root}
      onKeyDown={(e) => {
        if (e.key === 'Escape' && sel.selected.size > 0 && !search.open) setSel(EMPTY_SELECTION)
      }}
    >
      <div className="dshws-toolbar">
        <IconFolder open />
        <span className="dshws-toolbar-title" title={`${workspace.title}: ${displayPath(root)}`}>
          {workspace.title}
        </span>
        <IconButton title={t('side.search')} active={search.open} onClick={() => setSearch((s) => ({ open: !s.open, query: s.query }))}>
          <IconSearch />
        </IconButton>
        <IconButton title={t('add.showHidden')} active={showHidden} onClick={() => setShowHidden(!showHidden)}>
          <IconEye off={!showHidden} />
        </IconButton>
        <IconButton title={t('add.refresh')} onClick={refreshAll}>
          <IconRefresh />
        </IconButton>
      </div>
      {search.open ? (
        <div className="dshws-tree-search">
          <IconSearch size={14} />
          <input
            className="dshws-tree-search-input"
            value={search.query}
            placeholder={t('side.searchPlaceholder')}
            aria-label={t('side.search')}
            spellCheck={false}
            autoFocus
            onChange={(e) => setSearch({ open: true, query: e.target.value })}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.stopPropagation()
                setSearch({ open: false, query: '' })
              }
            }}
          />
          {search.query !== '' ? (
            <IconButton title={t('side.closeSearch')} onClick={() => setSearch({ open: false, query: '' })}>
              <IconClose size={14} />
            </IconButton>
          ) : null}
        </div>
      ) : null}
      {multi ? (
        <div className="dshws-subbar dshws-tree-selbar">
          <span>{t('ctx.selected', { count: sel.selected.size })}</span>
          <button type="button" className="dshws-linkbtn" onClick={() => setSel(EMPTY_SELECTION)}>
            {t('side.clearSelection')}
          </button>
        </div>
      ) : (
        <div className="dshws-subbar dshws-mono" title={displayPath(root)}>
          {displayPath(root)}
        </div>
      )}
      {search.open && found !== null ? (
        <VirtualList
          items={hits}
          itemKey={(h) => h.path}
          itemHeight={() => ROW_HEIGHT}
          renderItem={renderHit}
          header={searchNote !== null ? <div className="dshws-tree-note" data-tone={found.error !== undefined ? 'error' : undefined}>{searchNote}</div> : undefined}
        />
      ) : (
        <div className="dshws-tree-drop" {...dnd}>
          <VirtualList
            items={rows}
            itemKey={(r) => (r.kind === 'entry' ? r.entry.path : r.key)}
            itemHeight={(r) => (r.kind === 'entry' ? ROW_HEIGHT : NOTE_HEIGHT)}
            renderItem={renderRow}
            scrollTo={focus === null ? undefined : { key: focus.path, nonce: focus.nonce }}
            onContextMenu={menu.openForRoot}
            footer={rootEmpty ? <EmptyState text={t('add.emptyDir')} /> : undefined}
          />
          {dropDir !== null ? <div className="dshws-drop-hint">{t('files.dropHere', { dir: relativeTo(root, dropDir) === '.' ? workspace.title : relativeTo(root, dropDir) })}</div> : null}
        </div>
      )}
      {menu.node}
    </div>
  )

  return (
    <Split
      list={list}
      storageKey="files"
      resizeLabel={t('side.resizeList')}
      onWideChange={(w) => {
        wideRef.current = w
      }}
      placeholder={<EmptyState icon={<IconFile size={30} />} text={t('side.pickFile')} />}
      detail={
        selected === null ? null : (
          <RemoteFileViewer
            key={selected}
            t={t}
            api={api}
            hostId={workspace.hostId}
            remotePath={selected}
            workspaceTitle={workspace.title}
            workspaceRoot={workspace.remotePath}
            onClose={() => setSelected(null)}
          />
        )
      }
    />
  )
}
