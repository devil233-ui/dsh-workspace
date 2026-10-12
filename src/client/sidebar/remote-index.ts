/*
 * @Description: 侧边栏用的「远程会话」判定 —— 远程工作区列表缓存、文件地址解析、路径映射
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/sidebar/remote-index.ts
 *
 * DSH 右侧栏的 canOpen 是同步调用，所以远程工作区列表必须预先缓存在浏览器里；
 * 会话列表变化（新建会话、新建工作区）时刷新。
 */
import type { RemoteWorkspaceView } from '../../wire/dto.js'

/** DSH 文件资源地址前缀（格式与 @deepseek-ai/dsh-util-workspace-path 的 fileAddressFor 一致）。 */
export const FILE_ADDRESS_PREFIX = 'dsh-resource://file/'

export type FileAddress = { scope: 'session'; sessionId: string; path: string } | { scope: 'absolute'; path: string }

/** 解析 dsh-resource://file/ 地址；非法返回 undefined。 */
export function parseFileAddress(address: string): FileAddress | undefined {
  try {
    if (!address.startsWith(FILE_ADDRESS_PREFIX)) return undefined
    const end = address.search(/[?#]/)
    const [scope, ...rest] = address.slice(FILE_ADDRESS_PREFIX.length, end === -1 ? undefined : end).split('/')
    if (scope === 'session') {
      const [id, ...segments] = rest
      if (id === undefined || id === '') return undefined
      // 宿主 fileAddressFor 对「工作区根本身」生成空相对路径（.../session/<id>/，被改写时也可能丢掉结尾的 /），按工作区根处理。
      return { scope, sessionId: decodeURIComponent(id), path: segments.map(decodeURIComponent).join('/') }
    }
    if (scope === 'absolute') {
      if (rest.length === 0) return undefined
      const joined = rest.map(decodeURIComponent).join('/')
      // 盘符路径 C:/x 原样；POSIX 路径补回前导 /；UNC 保留 //。
      return { scope, path: /^[A-Za-z]:/.test(joined) ? joined : `/${joined}` }
    }
    return undefined
  } catch {
    return undefined
  }
}

/** 会话范围的文件地址（远程绝对路径保留前导 /，与 DSH 生成的写法一致）。 */
export function sessionFileAddress(sessionId: string, path: string): string {
  const enc = (s: string): string => encodeURIComponent(s).replace(/%3A/gi, ':')
  return `${FILE_ADDRESS_PREFIX}session/${enc(sessionId)}/${path.split('/').map(enc).join('/')}`
}

/**
 * 本地文件（本地 POSIX 形式）的绝对文件地址：交给宿主 / 其他插件的查看器打开本地文件。
 * /C:/x/a.ts → dsh-resource://file/absolute/C:/x/a.ts；/home/a → dsh-resource://file/absolute/home/a
 */
export function localFileAddress(p: string): string {
  const enc = (s: string): string => encodeURIComponent(s).replace(/%3A/gi, ':')
  const native = /^\/[A-Za-z]:/.test(p) ? p.slice(1) : p.replace(/^\/+/, '')
  return `${FILE_ADDRESS_PREFIX}absolute/${native.split('/').map(enc).join('/')}`
}

/** 本地 POSIX 形式 → 宿主地址里的写法（正斜杠原生路径）：/C:/x/a → C:/x/a；/home/a 原样。 */
export function nativeSlashPath(p: string): string {
  return /^\/[A-Za-z]:(\/|$)/.test(p) ? p.slice(1) : p
}

/**
 * 本机会话里文件的地址，规则与宿主 chat 的 fileAddressFor 一致（dsh-util-workspace-path）：
 * 在会话工作区内 → 相对路径的 session 地址；工作区外 → 绝对路径的 session 地址。
 * 与宿主一致的意义：同一文件从聊天链接与文件树打开得到同一个地址，右栏按地址去重，不会开出两个标签。
 */
export function localSessionAddress(sessionId: string, cwd: string | undefined, localPosixPath: string): string {
  const normalized = nativeSlashPath(localPosixPath)
  const root = cwd === undefined ? '' : cwd.replace(/\\/g, '/').replace(/\/+$/, '')
  if (root !== '' && normalized === root) return sessionFileAddress(sessionId, '')
  if (root !== '' && normalized.startsWith(`${root}/`)) return sessionFileAddress(sessionId, normalized.slice(root.length + 1))
  return sessionFileAddress(sessionId, normalized)
}

/**
 * 本机路径 p 是否在 root 内（含 root；Windows 风格不区分大小写）。两者可以是原生或本地 POSIX 形式。
 * 先折叠 . 与 ..、合并重复斜杠再比较：C:/w/../other 字面上以 C:/w/ 开头，不规范化会被误判为在工作区内。
 */
export function isInsideLocal(root: string, p: string): boolean {
  const r = localKey(nativeSlashPath(normalizeLocalPosix(root)))
  const k = localKey(nativeSlashPath(normalizeLocalPosix(p)))
  return k === r || k.startsWith(`${r}/`)
}

/** 本机路径（原生或本地 POSIX 形式）→ 规范化的本地 POSIX 形式（统一斜杠、折叠 . 与 ..、去重复 / 结尾斜杠）；UNC 保留开头的 //。 */
export function normalizeLocalPosix(p: string): string {
  const s = toLocalPosix(p)
  return s.startsWith('//') ? `/${normalizePosix(s.slice(1))}` : normalizePosix(s)
}

/**
 * 本机路径的比较键：统一斜杠、去结尾斜杠。
 * 只有 Windows 风格路径（盘符 / UNC）忽略大小写 —— Linux 区分大小写，一律转小写会让只差大小写的两个工作区互相串。
 */
export function localKey(p: string): string {
  const s = p.replace(/\\/g, '/').replace(/\/+$/, '')
  return /^[A-Za-z]:\//.test(s) || /^[A-Za-z]:$/.test(s) || s.startsWith('//') ? s.toLowerCase() : s
}

/**
 * POSIX 路径规范化（折叠 . 与 ..，合并重复斜杠，去结尾斜杠）。
 * 本地 POSIX 形式的盘符段（/C:/...）固定不弹出：C:/w/../../x 应停在 C:/x，弹掉盘符会变成 /x（别的路径）。
 */
export function normalizePosix(p: string): string {
  const out: string[] = []
  const parts = p.split('/')
  const drive = parts.find((part) => part !== '')
  const pinned = drive !== undefined && /^[A-Za-z]:$/.test(drive) ? 1 : 0
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (out.length > pinned) out.pop()
    } else out.push(part)
  }
  return `/${out.join('/')}`
}

/**
 * 地址里的路径 → 远程绝对路径。
 * - 远程绝对路径（/home/...）原样
 * - 占位目录下的本机路径（模型照抄会话 cwd）换成远程根下的对应路径
 * - 相对路径相对远程根
 * 其他本机路径返回 undefined（不属于这个远程工作区）。
 */
export function toRemotePath(ws: RemoteWorkspaceView, input: string): string | undefined {
  const p = input.replace(/\\/g, '/')
  // 先判断是否位于占位目录下：macOS / Linux 的占位目录本身就以 / 开头（/Users/me/.dsh/...），
  // 若先按「/ 开头 = 远程路径」处理，会把本机路径原样当远程路径用。
  const key = localKey(p)
  const root = localKey(ws.localPath)
  if (key === root || key.startsWith(`${root}/`)) {
    const rel = p.slice(ws.localPath.replace(/\\/g, '/').replace(/\/+$/, '').length)
    return normalizePosix(`${ws.remotePath}/${rel}`)
  }
  if (/^[A-Za-z]:\//.test(p) || p.startsWith('//')) return undefined
  if (p.startsWith('/')) return normalizePosix(p)
  return normalizePosix(`${ws.remotePath}/${p}`)
}

/**
 * 「显示文件位置」的定位计划：从根到文件所在目录要展开的每一级；路径中有点开头的段时需要显示隐藏文件。
 * 不在根下（含规范化后经 .. 跳出、前缀相似的兄弟目录）或就是根本身返回 undefined（不是这个工作区里的条目，不定位）。
 * target 是规范化后、沿用根写法的定位路径：文件树按根拼接子路径，本机 Windows 根（/C:/...）只差大小写时也要能对上。
 */
export function revealPlan(root: string, target: string): { dirs: string[]; hidden: boolean; target: string } | undefined {
  const base = normalizePosix(root)
  const norm = normalizePosix(target)
  // 本地 POSIX 形式的 Windows 根（/C:/...）不区分大小写；远程与 macOS / Linux 本机路径区分大小写。
  const fold = (s: string): string => (/^\/[A-Za-z]:(\/|$)/.test(base) ? s.toLowerCase() : s)
  if (fold(norm) === fold(base) || !fold(norm).startsWith(base === '/' ? '/' : `${fold(base)}/`)) return undefined
  const segments = norm.slice(base === '/' ? 1 : base.length + 1).split('/').filter(Boolean)
  if (segments.length === 0) return undefined
  const dirs: string[] = []
  let cur = base
  for (const seg of segments.slice(0, -1)) {
    cur = cur === '/' ? `/${seg}` : `${cur}/${seg}`
    dirs.push(cur)
  }
  return { dirs, hidden: segments.some((s) => s.startsWith('.')), target: `${base === '/' ? '' : base}/${segments.join('/')}` }
}

/** 本地会话在线上的「主机 id」前缀（与宿主 local/local-fs.ts 的 LOCAL_ID_PREFIX 一致）。 */
export const LOCAL_HOST_PREFIX = 'local:'

/** 侧栏面板的工作区：远程工作区，或本地会话的 cwd。 */
export interface SideWorkspace extends RemoteWorkspaceView {
  local: boolean
}

/** 本机路径 → 本地 POSIX 形式（C:\x → /C:/x；macOS / Linux 原样），去掉结尾斜杠。 */
export function toLocalPosix(p: string): string {
  const s = p.replace(/\\/g, '/')
  const trimmed = s.length > 1 ? s.replace(/\/+$/, '') : s
  return /^[A-Za-z]:/.test(trimmed) ? `/${trimmed}` : trimmed
}

/** 界面显示 / 复制用的路径：本地 Windows 路径还原成 C:\x\y，其余原样。 */
export function displayPath(p: string): string {
  return /^\/[A-Za-z]:(\/|$)/.test(p) ? p.slice(1).replace(/\//g, '\\') : p
}

function baseNameOf(p: string): string {
  const s = p.replace(/[\\/]+$/, '')
  return s.slice(Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\')) + 1) || s
}

interface SessionsService {
  list: { getSnapshot(): { byId: Record<string, { cwd?: string } | undefined> }; subscribe(listener: () => void): () => void }
}

/** 远程工作区索引：列表缓存 + 按会话 / 本机路径查找。 */
export class RemoteIndex {
  private list: RemoteWorkspaceView[] = []
  private listeners = new Set<() => void>()

  constructor(
    private readonly load: () => Promise<RemoteWorkspaceView[]>,
    private readonly sessions: () => SessionsService | undefined
  ) {}

  /**
   * 重新拉取列表。只有内容真的变了才通知订阅者，且未变的条目沿用旧对象：
   * 会话列表在 Agent 运行时变化非常频繁（每次都会触发这里），若每次都换新对象，
   * 依赖 workspace 的面板（远程 Git / 远程文件）会反复整页重载，并关掉右侧已打开的预览。
   */
  async refresh(): Promise<void> {
    try {
      const next = await this.load()
      const oldByKey = new Map(this.list.map((w) => [JSON.stringify(w), w]))
      const merged = next.map((w) => oldByKey.get(JSON.stringify(w)) ?? w)
      const changed = merged.length !== this.list.length || merged.some((w, i) => w !== this.list[i])
      if (!changed) return
      this.list = merged
      for (const l of this.listeners) l()
    } catch {
      /* 宿主未就绪：保留旧列表，下次会话变化时再试 */
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** 某本机路径（会话 cwd）所属的远程工作区。 */
  byLocalPath(p: string | undefined): RemoteWorkspaceView | undefined {
    if (p === undefined || p === '') return undefined
    const key = localKey(p)
    return this.list.find((w) => {
      const root = localKey(w.localPath)
      return key === root || key.startsWith(`${root}/`)
    })
  }

  sessionCwd(sessionId: string): string | undefined {
    return this.sessions()?.list.getSnapshot().byId[sessionId]?.cwd
  }

  bySession(sessionId: string): RemoteWorkspaceView | undefined {
    return this.byLocalPath(this.sessionCwd(sessionId))
  }

  private localCache = new Map<string, SideWorkspace>()

  /**
   * 「文件管理」「Git 仓库」用的工作区：远程会话 = 远程工作区；本地会话 = 会话 cwd（hostId 为 local:<会话 id>，
   * 路径用本地 POSIX 形式，宿主按会话推导根目录并限制在其内）。没有 cwd 返回 undefined。
   * 同一会话、同一 cwd 返回同一个对象，依赖它的面板不会因为对象换了而重载。
   */
  workspaceFor(sessionId: string): SideWorkspace | undefined {
    const remote = this.bySession(sessionId)
    if (remote !== undefined) return { ...remote, local: false }
    const cwd = this.sessionCwd(sessionId)
    if (cwd === undefined || cwd === '') return undefined
    const cached = this.localCache.get(sessionId)
    if (cached !== undefined && cached.localPath === cwd) return cached
    const view: SideWorkspace = {
      localPath: cwd,
      hostId: `${LOCAL_HOST_PREFIX}${sessionId}`,
      remotePath: toLocalPosix(cwd),
      title: baseNameOf(cwd),
      local: true
    }
    this.localCache.set(sessionId, view)
    return view
  }

  /**
   * 本机文件地址 → 本机路径（本地 POSIX 形式）。远程工作区会话 / 远程占位目录里的地址返回 undefined（归 resolveAddress）。
   * - session 范围：相对路径按该会话 cwd 拼接（cwd 未知时无法解析）；绝对路径原样。
   *   空路径 / '.' / './' 就是会话工作区根本身（宿主 fileAddressFor 对根生成空相对路径）：照样认领，查看器探测到目录后改开「文件管理」；
   *   不认领就会落到宿主自带的查看器，它拿空路径去读，报「path is required」。
   * - absolute 范围：任意本机绝对路径（卸载 better-sidebar 后这类地址也要有人认领）。
   * 返回的路径一律规范化（统一斜杠、折叠 . 与 ..、去重复 / 结尾斜杠）；是否仍在工作区内由调用方用 isInsideLocal 判断。
   * 返回的 sessionId / cwd 供查看器判断「是否在该会话工作区内、能否保存」。
   */
  resolveLocalAddress(address: string): { path: string; sessionId?: string; cwd?: string } | undefined {
    const parsed = parseFileAddress(address)
    if (parsed === undefined) return undefined
    if (parsed.scope === 'session') {
      if (this.bySession(parsed.sessionId) !== undefined) return undefined
      const cwd = this.sessionCwd(parsed.sessionId)
      const p = parsed.path.replace(/\\/g, '/')
      if (p.startsWith('//')) return undefined
      const absolute = p.startsWith('/') || /^[A-Za-z]:(\/|$)/.test(p)
      if (!absolute && (cwd === undefined || cwd === '')) return undefined
      const joined = absolute ? p : `${(cwd as string).replace(/\\/g, '/').replace(/\/+$/, '')}/${p}`
      return { path: normalizeLocalPosix(joined), sessionId: parsed.sessionId, ...(cwd !== undefined && cwd !== '' ? { cwd } : {}) }
    }
    if (this.byLocalPath(parsed.path) !== undefined) return undefined
    if (parsed.path.startsWith('//')) return undefined
    return { path: normalizeLocalPosix(parsed.path) }
  }

  /** 文件地址 → {工作区, 远程路径}；不属于远程工作区返回 undefined。 */
  resolveAddress(address: string): { workspace: RemoteWorkspaceView; remotePath: string; sessionId?: string } | undefined {
    const parsed = parseFileAddress(address)
    if (parsed === undefined) return undefined
    if (parsed.scope === 'session') {
      const workspace = this.bySession(parsed.sessionId)
      if (workspace === undefined) return undefined
      const remotePath = toRemotePath(workspace, parsed.path === '' ? '.' : parsed.path)
      return remotePath === undefined ? undefined : { workspace, remotePath, sessionId: parsed.sessionId }
    }
    const workspace = this.byLocalPath(parsed.path)
    if (workspace === undefined) return undefined
    const remotePath = toRemotePath(workspace, parsed.path)
    return remotePath === undefined ? undefined : { workspace, remotePath }
  }
}
