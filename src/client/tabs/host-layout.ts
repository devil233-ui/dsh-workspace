/*
 * @Description: 右侧栏布局的内部字段探测与读取 —— 每会话布局（窗格 / 标签顺序）、订阅、同窗格重排、导航参数
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/host-layout.ts
 *
 * 为什么要碰内部字段：宿主公开的 ctx.sidebarRight 只有 openResource / openTab / close / mounted / openTabs，
 * 拿不到「标签在哪个窗格、按什么顺序」，也没有重排接口。固定标签需要这两样，所以按结构探测控制器上的内部字段：
 * - adopted.get(sid).store：该会话的布局仓库（getSnapshot().bySession[sid].layout、subscribe、actions.placeTab）；
 * - tabsIn / openResourceIn / openTabIn / closeIn：作用于指定会话的打开 / 关闭（插件 sidechat/host.ts 已在用）；
 * - tabDomain.occurrence(sid, { id }).navigation：标签当前的导航参数（固定时保存必要的 params）。
 * 任何一项缺失都只降级（返回 undefined / false），绝不抛错 —— 调用方据此决定只提供哪些菜单项。
 * 注意：这些都是 sidebarRight 服务对象自身的普通字段（不是 cordis 子服务），可以直接属性访问；仍一律包 try/catch。
 */

/** 宿主标签记录（layout.tabs 的值）。 */
export interface TabRecordLike {
  id: string
  kind: string
  contentId: string
  title?: string
}

export interface PaneNodeLike {
  kind: 'pane'
  id: string
  host: 'dock' | 'float'
  /** 按可视顺序。 */
  tabs: string[]
  activeTabId?: string
}

export interface SplitNodeLike {
  kind: 'split'
  id: string
  children: string[]
}

/** 宿主 dockkit 布局的最小形状。 */
export interface LayoutLike {
  rootId: string
  nodes: Record<string, PaneNodeLike | SplitNodeLike | undefined>
  floats: string[]
  expanded: boolean
  tabs: Record<string, TabRecordLike | undefined>
  activePaneId?: string
}

interface StoreLike {
  getSnapshot(): { bySession?: Record<string, { layout?: unknown } | undefined> } | undefined
  subscribe(listener: () => void): () => void
  actions?: { placeTab?: (sessionId: string, tabId: string, paneId: string, index: number) => void }
}

/** sidebarRight 控制器上本模块用到的面（公开 + 非公开），全部可选。 */
export interface SidebarRightLike {
  openResource?(address: string, options?: Record<string, unknown>): void
  openTab?(kind: string, options?: Record<string, unknown>): void
  close?(tabId: string): void
  openResourceIn?(sessionId: string, address: string, options?: Record<string, unknown>): void
  openTabIn?(sessionId: string, kind: string, options?: Record<string, unknown>): void
  closeIn?(sessionId: string, tabId: string): void
  tabsIn?(sessionId: string): readonly TabRecordLike[]
  mounted?: { getSnapshot(): string | undefined; subscribe(listener: () => void): () => void }
  openTabs?: { getSnapshot(): ReadonlyArray<{ sessionId: string; tabId: string; kind: string; contentId: string }> }
  adopted?: { get(sessionId: string): { store?: StoreLike } | undefined }
  tabDomain?: { occurrence(sessionId: string, tab: { id: string }): { navigation?: { getSnapshot(): { address?: string; params?: unknown } | undefined } } }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null
const isFn = (o: unknown, key: string): boolean => isObj(o) && typeof o[key] === 'function'

/** 宿主 pageAddress(kind)：页面标签的地址。 */
export function pageAddress(kind: string): string {
  return `sidebar://${kind}`
}

/** 结构校验：只认得出窗格树与标签表时才算布局（宿主改了形状就降级，而不是读出错数据）。 */
export function asLayout(raw: unknown): LayoutLike | undefined {
  if (!isObj(raw) || typeof raw.rootId !== 'string' || !isObj(raw.nodes) || !isObj(raw.tabs)) return undefined
  if (!isObj(raw.nodes[raw.rootId])) return undefined
  return {
    rootId: raw.rootId,
    nodes: raw.nodes as LayoutLike['nodes'],
    floats: Array.isArray(raw.floats) ? (raw.floats as string[]) : [],
    expanded: raw.expanded === true,
    tabs: raw.tabs as LayoutLike['tabs'],
    ...(typeof raw.activePaneId === 'string' ? { activePaneId: raw.activePaneId } : {})
  }
}

/** 停靠窗格 id（从左到右，与宿主 dockPaneIds 相同的深度优先顺序）。 */
export function dockPaneIds(layout: LayoutLike): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const walk = (id: string): void => {
    if (seen.has(id)) return
    seen.add(id)
    const node = layout.nodes[id]
    if (node === undefined) return
    if (node.kind === 'pane') {
      out.push(node.id)
      return
    }
    if (Array.isArray(node.children)) for (const child of node.children) walk(child)
  }
  walk(layout.rootId)
  return out
}

/** 所有窗格（停靠在前、浮窗在后）。 */
export function allPanes(layout: LayoutLike): PaneNodeLike[] {
  const out: PaneNodeLike[] = []
  for (const id of [...dockPaneIds(layout), ...layout.floats]) {
    const node = layout.nodes[id]
    if (node?.kind === 'pane' && Array.isArray(node.tabs)) out.push(node)
  }
  return out
}

/** 标签所在窗格。 */
export function paneOf(layout: LayoutLike, tabId: string): PaneNodeLike | undefined {
  return allPanes(layout).find((p) => p.tabs.includes(tabId))
}

/** 宿主能力探测结果：决定菜单项与排序 / 补开是否可用。 */
export interface HostCaps {
  /** 能读到会话布局（窗格 + 顺序）。 */
  layout: boolean
  /** 能重排（store.actions.placeTab）。 */
  place: boolean
  /** 能按会话关闭（closeIn）。 */
  closeIn: boolean
  /** 能按会话打开（openResourceIn + openTabIn）。 */
  openIn: boolean
}

/** 取会话的布局仓库；拿不到返回 undefined。 */
export function storeOf(right: SidebarRightLike | undefined, sessionId: string): StoreLike | undefined {
  try {
    const adopted = right?.adopted
    if (!isFn(adopted, 'get')) return undefined
    const store = adopted!.get(sessionId)?.store
    return isFn(store, 'getSnapshot') && isFn(store, 'subscribe') ? store : undefined
  } catch {
    return undefined
  }
}

/** 读会话布局；未加载（宿主还没给这个会话建 surface）返回 undefined。 */
export function readLayout(right: SidebarRightLike | undefined, sessionId: string): LayoutLike | undefined {
  const store = storeOf(right, sessionId)
  if (store === undefined) return undefined
  try {
    return asLayout(store.getSnapshot()?.bySession?.[sessionId]?.layout)
  } catch {
    return undefined
  }
}

export function capsOf(right: SidebarRightLike | undefined, sessionId: string): HostCaps {
  const store = storeOf(right, sessionId)
  return {
    layout: readLayout(right, sessionId) !== undefined,
    place: store !== undefined && isFn(store.actions, 'placeTab'),
    closeIn: isFn(right, 'closeIn'),
    openIn: isFn(right, 'openResourceIn') && isFn(right, 'openTabIn')
  }
}

/** 同窗格重排（宿主 placeTab：同窗格转 reorderTab，不改激活）。失败返回 false。 */
export function placeTab(right: SidebarRightLike | undefined, sessionId: string, tabId: string, paneId: string, index: number): boolean {
  const store = storeOf(right, sessionId)
  if (store === undefined || !isFn(store.actions, 'placeTab')) return false
  try {
    store.actions!.placeTab!(sessionId, tabId, paneId, index)
    return true
  } catch {
    return false
  }
}

/** 标签当前的导航参数（宿主不持久化 params，刷新后为 undefined）。 */
export function navigationParams(right: SidebarRightLike | undefined, sessionId: string, tabId: string): unknown {
  try {
    if (!isFn(right?.tabDomain, 'occurrence')) return undefined
    return right!.tabDomain!.occurrence(sessionId, { id: tabId }).navigation?.getSnapshot()?.params
  } catch {
    return undefined
  }
}

/** 当前显示的会话。 */
export function mountedSession(right: SidebarRightLike | undefined): string | undefined {
  try {
    return isFn(right?.mounted, 'getSnapshot') ? right!.mounted!.getSnapshot() : undefined
  } catch {
    return undefined
  }
}

/** 降级用：公开的 openTabs 里某会话的标签（无窗格信息、非可视顺序）。 */
export function openTabsOf(right: SidebarRightLike | undefined, sessionId: string): TabRecordLike[] {
  try {
    if (!isFn(right?.openTabs, 'getSnapshot')) return []
    return right!.openTabs!.getSnapshot()
      .filter((t) => t.sessionId === sessionId)
      .map((t) => ({ id: t.tabId, kind: t.kind, contentId: t.contentId }))
  } catch {
    return []
  }
}
