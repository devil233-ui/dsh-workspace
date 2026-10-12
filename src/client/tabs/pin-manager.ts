/*
 * @Description: 固定标签的运行时 —— 跟随当前显示会话订阅布局：关闭即取消固定、记住窗格、展开时补开、固定标签排到窗格最左、隐藏关闭按钮
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/pin-manager.ts
 *
 * 为什么只跟当前显示的会话：右侧栏同一时刻只显示一个会话（mounted），布局仓库要等宿主 adopt 之后才拿得到
 * （切换会话时 mounted 先变，adopted.get(sid) 稍后才出现），所以挂上前短轮询。
 * 所有派发（补开 / 重排 / 恢复激活）都放进 queueMicrotask，不在仓库订阅回调里同步 dispatch：
 * 宿主仓库正在通知订阅者时再派发会重入；重排后布局再次变化，下一轮算出「顺序已正确」就不再发动作，不会循环。
 * 宿主能力缺失（无 adopted / store / placeTab / closeIn）时只降级，不抛错：见 host-layout.ts 的 capsOf。
 */
import {
  dockPaneIds,
  mountedSession,
  navigationParams,
  placeTab,
  readLayout,
  storeOf,
  type LayoutLike,
  type SidebarRightLike,
  type TabRecordLike
} from './host-layout.js'
import {
  closedPins,
  loadPins,
  pinCss,
  pinKey,
  pinnedTabIds,
  planReopen,
  planReorder,
  presentPinKeys,
  rememberPanes,
  sanitizeParams,
  savePins,
  type PinEntry,
  type StorageLike
} from './pins.js'

export interface PinManagerDeps {
  right(): SidebarRightLike | undefined
  /** 注册表里该 kind 是否 multiple（查不到返回 undefined）。 */
  isMultiple(kind: string): boolean | undefined
  storage(): StorageLike | undefined
  log(message: string, error?: unknown): void
  /** 测试注入：默认 queueMicrotask / setTimeout / document。 */
  schedule?(fn: () => void): void
  delay?(fn: () => void, ms: number): () => void
  doc?(): Document | undefined
}

export interface PinManager {
  subscribe(listener: () => void): () => void
  /** 每次固定表变化 +1（React useSyncExternalStore 用）。 */
  version(): number
  pins(sessionId: string): readonly PinEntry[]
  /** 布局里被固定的标签 id。读不到布局时为空集。 */
  pinnedIds(sessionId: string): Set<string>
  isPinned(sessionId: string, tab: Pick<TabRecordLike, 'kind' | 'contentId'>): boolean
  pin(sessionId: string, tab: TabRecordLike): boolean
  unpin(sessionId: string, tab: Pick<TabRecordLike, 'kind' | 'contentId'>): void
  dispose(): void
}

/** 等宿主 adopt 会话布局：每 100ms 看一次，最多 10 秒。 */
const ATTACH_POLL_MS = 100
const ATTACH_POLL_MAX = 100
const STYLE_ATTR = 'data-dshws-pins'

interface Attachment {
  sessionId: string
  store: unknown
  off: () => void
  /** 上一次观察到存在的固定项（undefined = 还没观察过布局）。 */
  present?: Set<string>
  expanded?: boolean
  reopen: boolean
  /** 重排后仍不对（宿主语义变了）：本次挂载内不再重排，避免循环。 */
  stuck: boolean
}

export function createPinManager(deps: PinManagerDeps): PinManager {
  const schedule = deps.schedule ?? ((fn: () => void) => queueMicrotask(fn))
  const delay =
    deps.delay ??
    ((fn: () => void, ms: number) => {
      const timer = setTimeout(fn, ms)
      return () => clearTimeout(timer)
    })
  const doc = deps.doc ?? (() => (typeof document === 'undefined' ? undefined : document))
  const cache = new Map<string, PinEntry[]>()
  const listeners = new Set<() => void>()
  let ver = 0
  let disposed = false
  let attached: Attachment | undefined
  let cancelPoll: (() => void) | undefined
  let queued = false
  let style: HTMLStyleElement | undefined

  const notify = (): void => {
    ver += 1
    for (const l of [...listeners]) {
      try {
        l()
      } catch (error) {
        deps.log('固定标签订阅回调出错', error)
      }
    }
  }
  const getPins = (sessionId: string): PinEntry[] => {
    let list = cache.get(sessionId)
    if (list === undefined) {
      list = loadPins(deps.storage(), sessionId)
      cache.set(sessionId, list)
    }
    return list
  }
  const setPins = (sessionId: string, list: readonly PinEntry[], silent = false): void => {
    cache.set(sessionId, [...list])
    savePins(deps.storage(), sessionId, list)
    if (!silent) notify()
  }

  // ---------------------------------------------------------------- CSS（隐藏固定标签的关闭按钮）
  const writeCss = (text: string): void => {
    const d = doc()
    if (d === undefined) return
    if (text === '') {
      style?.remove()
      style = undefined
      return
    }
    if (style === undefined || !style.isConnected) {
      style = d.createElement('style')
      style.setAttribute(STYLE_ATTR, '')
      d.head.appendChild(style)
    }
    if (style.textContent !== text) style.textContent = text
  }
  const refreshCss = (): void => {
    const a = attached
    const layout = a === undefined ? undefined : readLayout(deps.right(), a.sessionId)
    writeCss(a === undefined || layout === undefined ? '' : pinCss(a.sessionId, pinnedTabIds(layout, getPins(a.sessionId)).keys()))
  }

  // ---------------------------------------------------------------- 派发（微任务里执行）
  const reopen = (sessionId: string, layout: LayoutLike): void => {
    const right = deps.right()
    const ops = planReopen(layout, getPins(sessionId), deps.isMultiple)
    if (ops.length === 0 || right === undefined) return
    // 记下补开前的激活标签：展开往往是「打开某个文件」顺带的，补开不能把用户刚打开的内容盖掉。
    const active = activeTab(layout)
    for (const op of ops) {
      const { pin } = op
      const options = {
        paneId: op.paneId,
        ...(op.replaceTab !== undefined ? { replaceTab: op.replaceTab } : {}),
        ...(pin.params !== undefined ? { params: pin.params } : {})
      }
      try {
        if (pin.contentId.startsWith('dsh-resource://')) right.openResourceIn?.(sessionId, pin.contentId, { ...options, kind: pin.kind })
        else right.openTabIn?.(sessionId, pin.kind, options)
      } catch (error) {
        // 标签类型被关掉 / 不再认领该地址：本次跳过，固定记录保留（类型恢复后下次展开再补）。
        deps.log(`补开固定标签失败（${pin.kind}）`, error)
      }
    }
    if (active === undefined) return
    try {
      const store = storeOf(right, sessionId) as { actions?: { focusTab?: (sid: string, tabId: string) => void } } | undefined
      if (readLayout(right, sessionId)?.tabs[active] !== undefined) store?.actions?.focusTab?.(sessionId, active)
    } catch (error) {
      deps.log('恢复激活标签失败', error)
    }
  }
  const reorder = (a: Attachment): void => {
    if (a.stuck) return
    const right = deps.right()
    const layout = readLayout(right, a.sessionId)
    if (layout === undefined) return
    const ops = planReorder(layout, getPins(a.sessionId))
    if (ops.length === 0) return
    for (const op of ops) {
      if (!placeTab(right, a.sessionId, op.tabId, op.paneId, op.index)) {
        a.stuck = true
        return
      }
    }
    const after = readLayout(right, a.sessionId)
    if (after !== undefined && planReorder(after, getPins(a.sessionId)).length > 0) {
      a.stuck = true
      deps.log('固定标签重排未生效，本次停止自动排序')
    }
  }
  const flush = (): void => {
    queued = false
    const a = attached
    if (disposed || a === undefined) return
    if (a.reopen) {
      a.reopen = false
      const layout = readLayout(deps.right(), a.sessionId)
      if (layout !== undefined && layout.expanded) reopen(a.sessionId, layout)
    }
    reorder(a)
    refreshCss()
  }
  const kick = (): void => {
    if (queued || disposed) return
    queued = true
    schedule(() => {
      try {
        flush()
      } catch (error) {
        queued = false
        deps.log('固定标签处理失败', error)
      }
    })
  }

  // ---------------------------------------------------------------- 观察布局
  const observe = (a: Attachment): void => {
    if (disposed || attached !== a) return
    const layout = readLayout(deps.right(), a.sessionId)
    // 布局未加载（宿主还没给会话建 surface）：什么都不判，等下一次提交。
    if (layout === undefined) return
    let pins = getPins(a.sessionId)
    const gone = closedPins(a.present, layout, pins)
    if (gone.length > 0) {
      const drop = new Set(gone)
      pins = pins.filter((p) => !drop.has(pinKey(p)))
      setPins(a.sessionId, pins)
    }
    const remembered = rememberPanes(layout, pins)
    if (remembered !== pins) setPins(a.sessionId, remembered, true)
    a.present = presentPinKeys(layout, remembered)
    // 展开：false → true，或挂上时已展开（a.expanded 尚未记录）。
    if (layout.expanded && a.expanded !== true && remembered.length > 0) a.reopen = true
    a.expanded = layout.expanded
    refreshCss()
    if (remembered.length > 0) kick()
  }

  const detach = (): void => {
    cancelPoll?.()
    cancelPoll = undefined
    const a = attached
    attached = undefined
    if (a !== undefined) {
      try {
        a.off()
      } catch {
        /* 宿主仓库已释放 */
      }
    }
    writeCss('')
  }
  const attach = (sessionId: string | undefined, tries = 0): void => {
    if (disposed) return
    if (sessionId === undefined) return
    const store = storeOf(deps.right(), sessionId) as { subscribe(l: () => void): () => void } | undefined
    if (store === undefined) {
      if (tries < ATTACH_POLL_MAX) cancelPoll = delay(() => attach(sessionId, tries + 1), ATTACH_POLL_MS)
      return
    }
    const a: Attachment = { sessionId, store, off: () => undefined, reopen: false, stuck: false }
    attached = a
    try {
      a.off = store.subscribe(() => observe(a))
    } catch (error) {
      deps.log('订阅右侧栏布局失败', error)
    }
    observe(a)
  }
  const follow = (): void => {
    const sessionId = mountedSession(deps.right())
    const a = attached
    // 同一会话且仓库没换：保持；仓库换了（宿主重新 adopt）当作重新挂载。
    if (a !== undefined && a.sessionId === sessionId && storeOf(deps.right(), a.sessionId) === a.store) return
    detach()
    attach(sessionId)
  }

  let offMounted: (() => void) | undefined
  try {
    const mounted = deps.right()?.mounted
    if (typeof mounted?.subscribe === 'function') offMounted = mounted.subscribe(follow)
  } catch (error) {
    deps.log('订阅右侧栏当前会话失败', error)
  }
  follow()

  return {
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    version: () => ver,
    pins: (sessionId) => getPins(sessionId),
    pinnedIds(sessionId) {
      const layout = readLayout(deps.right(), sessionId)
      return layout === undefined ? new Set() : new Set(pinnedTabIds(layout, getPins(sessionId)).keys())
    },
    isPinned: (sessionId, tab) => getPins(sessionId).some((p) => pinKey(p) === pinKey(tab)),
    pin(sessionId, tab) {
      const right = deps.right()
      const layout = readLayout(right, sessionId)
      if (layout === undefined) return false
      const pins = getPins(sessionId)
      const key = pinKey(tab)
      if (pins.some((p) => pinKey(p) === key)) return true
      const docks = dockPaneIds(layout)
      const paneIndex = docks.findIndex((id) => {
        const node = layout.nodes[id]
        return node?.kind === 'pane' && node.tabs.includes(tab.id)
      })
      const params = sanitizeParams(navigationParams(right, sessionId, tab.id))
      const entry: PinEntry = {
        kind: tab.kind,
        contentId: tab.contentId,
        ...(params !== undefined ? { params } : {}),
        ...(typeof tab.title === 'string' && tab.title !== '' ? { title: tab.title } : {}),
        ...(paneIndex >= 0 ? { paneIndex, paneId: docks[paneIndex] } : {})
      }
      setPins(sessionId, [...pins, entry])
      const a = attached
      // 立刻记为「已观察到存在」：固定后马上关闭也能识别为取消固定，而不是被下次展开补回来。
      if (a !== undefined && a.sessionId === sessionId) {
        a.present = presentPinKeys(layout, getPins(sessionId))
        refreshCss()
        kick()
      }
      return true
    },
    unpin(sessionId, tab) {
      const key = pinKey(tab)
      const pins = getPins(sessionId)
      if (!pins.some((p) => pinKey(p) === key)) return
      setPins(
        sessionId,
        pins.filter((p) => pinKey(p) !== key)
      )
      attached?.present?.delete(key)
      refreshCss()
    },
    dispose() {
      disposed = true
      try {
        offMounted?.()
      } catch {
        /* 宿主已释放 */
      }
      detach()
      listeners.clear()
    }
  }
}

/** 激活窗格的激活标签。 */
function activeTab(layout: LayoutLike): string | undefined {
  const paneId = layout.activePaneId ?? dockPaneIds(layout)[0]
  const pane = paneId === undefined ? undefined : layout.nodes[paneId]
  return pane?.kind === 'pane' ? pane.activeTabId : undefined
}
