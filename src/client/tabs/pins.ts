/*
 * @Description: 右侧栏「固定标签」—— 按会话的存储 + 纯逻辑（可固定判断、关闭目标、补开计划、重排计划、关闭即取消固定、CSS 生成）
 * @Author: YangHeng
 * @Date: 2026-10-12 16:00:00
 * @FilePath: /dsh-workspace/src/client/tabs/pins.ts
 *
 * 固定项按 (kind, contentId) 识别，而不是 tabId：宿主重开同一内容会换新 tabId，按内容识别补开后才对得上。
 * 存储按会话独立（localStorage dshws.sidebar-pins.v1.<sessionId>），新会话不继承 —— 与宿主每会话布局（dsh.sidebar-right.v1.<sid>）同粒度。
 * 本文件只放纯函数与存储读写，便于单测；订阅 / 派发在 pin-manager.ts。
 */
import { SSH_ID } from '../sidebar/kinds.js'
import { allPanes, dockPaneIds, pageAddress, type LayoutLike, type TabRecordLike } from './host-layout.js'

/** 一条固定记录。paneId / paneIndex 记住所在停靠窗格（窗格 id 可能变化时以序号为准）。 */
export interface PinEntry {
  kind: string
  contentId: string
  params?: unknown
  title?: string
  paneIndex?: number
  paneId?: string
}

export const PINS_KEY_PREFIX = 'dshws.sidebar-pins.v1.'
/** 单会话固定上限：只防偏好被意外撑爆。 */
export const PINS_MAX = 50
/** params 序列化后的长度上限：超出就不带（固定仍成立，只是补开时没有参数）。 */
export const PIN_PARAMS_MAX = 4096

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** 固定项的识别键。 */
export function pinKey(p: { kind: string; contentId: string }): string {
  return `${p.kind}\n${p.contentId}`
}

/** 只保留可 JSON 往返、且不太大的 params；否则返回 undefined。 */
export function sanitizeParams(params: unknown): unknown {
  if (params === undefined || params === null) return undefined
  try {
    const text = JSON.stringify(params)
    if (text === undefined || text.length > PIN_PARAMS_MAX) return undefined
    const back = JSON.parse(text) as unknown
    return isObj(back) && Object.keys(back).length === 0 ? undefined : back
  } catch {
    return undefined
  }
}

/** 规范化：丢非法项、同一内容只留第一条、截断上限。 */
export function normalizePins(raw: unknown): PinEntry[] {
  if (!Array.isArray(raw)) return []
  const out: PinEntry[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!isObj(item) || typeof item.kind !== 'string' || item.kind === '' || typeof item.contentId !== 'string' || item.contentId === '') continue
    const key = pinKey(item as { kind: string; contentId: string })
    if (seen.has(key)) continue
    seen.add(key)
    const params = sanitizeParams(item.params)
    out.push({
      kind: item.kind,
      contentId: item.contentId,
      ...(params !== undefined ? { params } : {}),
      ...(typeof item.title === 'string' && item.title !== '' ? { title: item.title.slice(0, 200) } : {}),
      ...(typeof item.paneIndex === 'number' && Number.isInteger(item.paneIndex) && item.paneIndex >= 0 ? { paneIndex: item.paneIndex } : {}),
      ...(typeof item.paneId === 'string' && item.paneId !== '' ? { paneId: item.paneId } : {})
    })
    if (out.length >= PINS_MAX) break
  }
  return out
}

export function loadPins(storage: StorageLike | undefined, sessionId: string): PinEntry[] {
  try {
    const text = storage?.getItem(PINS_KEY_PREFIX + sessionId)
    return text === null || text === undefined ? [] : normalizePins(JSON.parse(text))
  } catch {
    return []
  }
}

export function savePins(storage: StorageLike | undefined, sessionId: string, pins: readonly PinEntry[]): void {
  try {
    // 空表直接删键：会话多了不会留下一堆空数组。
    if (pins.length === 0) storage?.removeItem(PINS_KEY_PREFIX + sessionId)
    else storage?.setItem(PINS_KEY_PREFIX + sessionId, JSON.stringify(pins))
  } catch {
    /* 存储不可用（隐私模式 / 配额）：只在内存里生效 */
  }
}

// ------------------------------------------------------------------ 可固定判断

/** 已知「可开多个」的标签类型：宿主终端 / 浏览器，本插件 SSH 终端。 */
export const MULTIPLE_KINDS: readonly string[] = ['terminal', 'browser', SSH_ID]

export type Pinnability = { ok: true } | { ok: false; reason: 'multiple' | 'unsupported' }

/**
 * 能否固定：固定靠「按地址重开」补回，所以只有能重开的标签才行。
 * - multiple kind（地址 sidebar://<kind>/<uuid>，或已知 kind）每次打开都是新实例，无法重开到同一个 → 不能固定；
 * - 资源地址 dsh-resource://… 用 openResource 重开；单例页面 sidebar://<kind> 用 openTab 重开；
 * - 引导页（guide）与其他地址 → 不支持。
 * @param isMultiple 注册表里该 kind 是否 multiple（查不到返回 undefined）
 */
export function pinnability(tab: Pick<TabRecordLike, 'kind' | 'contentId'>, isMultiple?: (kind: string) => boolean | undefined): Pinnability {
  const { kind, contentId } = tab
  if (MULTIPLE_KINDS.includes(kind) || isMultiple?.(kind) === true) return { ok: false, reason: 'multiple' }
  if (contentId.startsWith(`${pageAddress(kind)}/`)) return { ok: false, reason: 'multiple' }
  if (kind === 'guide') return { ok: false, reason: 'unsupported' }
  if (contentId.startsWith('dsh-resource://') || contentId === pageAddress(kind)) return { ok: true }
  return { ok: false, reason: 'unsupported' }
}

// ------------------------------------------------------------------ 布局匹配

/**
 * 固定项 → 布局里的标签 id（tabId → pinKey）。同一内容出现多次时只认第一个（停靠窗格从左到右，再浮窗），
 * 其余当普通标签 —— 「固定标签只出现一个」。
 */
export function pinnedTabIds(layout: LayoutLike, pins: readonly PinEntry[]): Map<string, string> {
  const wanted = new Set(pins.map(pinKey))
  const out = new Map<string, string>()
  const taken = new Set<string>()
  for (const pane of allPanes(layout)) {
    for (const id of pane.tabs) {
      const tab = layout.tabs[id]
      if (tab === undefined) continue
      const key = pinKey(tab)
      if (!wanted.has(key) || taken.has(key)) continue
      taken.add(key)
      out.set(id, key)
    }
  }
  return out
}

/** 布局里存在的固定项键。 */
export function presentPinKeys(layout: LayoutLike, pins: readonly PinEntry[]): Set<string> {
  return new Set(pinnedTabIds(layout, pins).values())
}

// ------------------------------------------------------------------ 关闭目标

export type CloseMode = 'left' | 'right' | 'others' | 'all'

/**
 * 关闭左侧 / 右侧 / 其他 / 全部的目标：只在该标签所在窗格内，跳过固定标签。
 * 「全部」包含该标签本身（它没固定时）；「其他」不含。返回按可视顺序的 tabId。
 */
export function closeTargets(layout: LayoutLike, tabId: string, mode: CloseMode, pinned: ReadonlySet<string>): string[] {
  const pane = allPanes(layout).find((p) => p.tabs.includes(tabId))
  if (pane === undefined) return []
  const index = pane.tabs.indexOf(tabId)
  const pick =
    mode === 'left'
      ? pane.tabs.slice(0, index)
      : mode === 'right'
        ? pane.tabs.slice(index + 1)
        : mode === 'others'
          ? pane.tabs.filter((id) => id !== tabId)
          : [...pane.tabs]
  return pick.filter((id) => !pinned.has(id) && layout.tabs[id] !== undefined)
}

/** 降级（读不到窗格）：只能按会话全体计算「其他 / 全部」。 */
export function closeTargetsFlat(tabs: readonly TabRecordLike[], tabId: string, mode: 'others' | 'all', pinned: ReadonlySet<string>): string[] {
  return tabs.map((t) => t.id).filter((id) => (mode === 'all' || id !== tabId) && !pinned.has(id))
}

// ------------------------------------------------------------------ 补开 / 重排

export interface ReopenOp {
  pin: PinEntry
  paneId: string
  /** 目标窗格只有宿主播种的引导页时顶替它（不留一个多余的引导页）。 */
  replaceTab?: string
}

/** 固定项该回到哪个停靠窗格：记住的 id 仍在就用它，否则按序号（越界取最右），都没有取最左。 */
export function targetPane(layout: LayoutLike, pin: Pick<PinEntry, 'paneId' | 'paneIndex'>): string | undefined {
  const docks = dockPaneIds(layout)
  if (docks.length === 0) return undefined
  if (pin.paneId !== undefined && docks.includes(pin.paneId)) return pin.paneId
  if (pin.paneIndex !== undefined) return docks[Math.min(pin.paneIndex, docks.length - 1)]
  return docks[0]
}

/**
 * 补开计划：布局里（含浮窗）找不到的固定项才补开；不可重开的（multiple / 不支持）跳过。
 * 已存在（哪怕在另一个窗格或浮窗里）一律不动 —— 分屏下固定标签只出现一个。
 */
export function planReopen(layout: LayoutLike, pins: readonly PinEntry[], isMultiple?: (kind: string) => boolean | undefined): ReopenOp[] {
  const present = presentPinKeys(layout, pins)
  const ops: ReopenOp[] = []
  const replaced = new Set<string>()
  for (const pin of pins) {
    if (present.has(pinKey(pin)) || !pinnability(pin, isMultiple).ok) continue
    const paneId = targetPane(layout, pin)
    if (paneId === undefined) continue
    const pane = layout.nodes[paneId]
    const only = pane?.kind === 'pane' && pane.tabs.length === 1 ? pane.tabs[0] : undefined
    const guide = only !== undefined && layout.tabs[only]?.kind === 'guide' && !replaced.has(only) ? only : undefined
    if (guide !== undefined) replaced.add(guide)
    ops.push({ pin, paneId, ...(guide !== undefined ? { replaceTab: guide } : {}) })
  }
  return ops
}

export interface ReorderOp {
  tabId: string
  paneId: string
  /** 宿主 placeTab 的插入位（同窗格：目标位在原位之前时即最终位置）。 */
  index: number
}

/**
 * 重排计划：每个停靠窗格里，固定标签按固定先后排在最左。顺序已正确返回空数组（不发任何动作）。
 * 逐个把第 j 个固定标签挪到位置 j：前 j 个已就位，所以它当前位置一定 > j，宿主 placeTab(index=j) 即最终位置。
 * 浮窗不排（宿主 placeTab 对浮窗目标是空操作）。
 */
export function planReorder(layout: LayoutLike, pins: readonly PinEntry[]): ReorderOp[] {
  const ids = pinnedTabIds(layout, pins)
  const order = new Map(pins.map((p, i) => [pinKey(p), i]))
  const ops: ReorderOp[] = []
  for (const paneId of dockPaneIds(layout)) {
    const pane = layout.nodes[paneId]
    if (pane?.kind !== 'pane') continue
    const tabs = [...pane.tabs]
    const pinned = tabs.filter((id) => ids.has(id)).sort((a, b) => (order.get(ids.get(a)!) ?? 0) - (order.get(ids.get(b)!) ?? 0))
    pinned.forEach((tabId, j) => {
      const from = tabs.indexOf(tabId)
      if (from === j) return
      tabs.splice(from, 1)
      tabs.splice(j, 0, tabId)
      ops.push({ tabId, paneId, index: j })
    })
  }
  return ops
}

/** 记住固定标签当前所在的停靠窗格；没有变化返回原数组（调用方据引用判断是否需要保存）。 */
export function rememberPanes(layout: LayoutLike, pins: readonly PinEntry[]): readonly PinEntry[] {
  const ids = pinnedTabIds(layout, pins)
  const byKey = new Map<string, string>()
  for (const [tabId, key] of ids) byKey.set(key, tabId)
  const docks = dockPaneIds(layout)
  let changed = false
  const next = pins.map((pin) => {
    const tabId = byKey.get(pinKey(pin))
    if (tabId === undefined) return pin
    const paneIndex = docks.findIndex((id) => {
      const node = layout.nodes[id]
      return node?.kind === 'pane' && node.tabs.includes(tabId)
    })
    // 在浮窗里：保留原记忆（收回停靠时宿主自己决定位置）。
    if (paneIndex < 0) return pin
    const paneId = docks[paneIndex]
    if (pin.paneId === paneId && pin.paneIndex === paneIndex) return pin
    changed = true
    return { ...pin, paneId, paneIndex }
  })
  return changed ? next : pins
}

/**
 * 关闭即取消固定：上一次观察到存在、这一次（同一会话、布局已加载）消失的固定项。
 * prev 为 undefined（刚挂上 / 会话切换 / 页面刷新后的第一次观察）或布局未加载时一律不判，避免恢复期间误删。
 */
export function closedPins(prev: ReadonlySet<string> | undefined, layout: LayoutLike | undefined, pins: readonly PinEntry[]): string[] {
  if (prev === undefined || layout === undefined) return []
  const now = presentPinKeys(layout, pins)
  return pins.map(pinKey).filter((key) => prev.has(key) && !now.has(key))
}

// ------------------------------------------------------------------ CSS

/** CSS 属性值转义（放进双引号里）。 */
function attr(value: string): string {
  return value.replace(/[\\"]/g, '\\$&').replace(/[\r\n\f]/g, ' ')
}

/** 隐藏固定标签的关闭按钮（按会话 + tabId 生成，只能右键关闭）。 */
export function pinCss(sessionId: string, tabIds: Iterable<string>): string {
  const rules: string[] = []
  for (const id of tabIds) {
    rules.push(`[data-sidebar-right-session="${attr(sessionId)}"] [data-dockkit-tab-close="${attr(id)}"]{display:none!important}`)
  }
  return rules.join('\n')
}
