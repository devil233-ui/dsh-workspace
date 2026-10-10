/*
 * @Description: 文件树多选的纯逻辑 —— Ctrl/⌘ 点选、Shift 连选（按当前可见行顺序）
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/tree-select.ts
 *
 * 与 VS Code 资源管理器一致：
 * - 普通点击：只选中这一项，并把它作为连选的锚点；
 * - Ctrl/⌘ 点击：切换这一项是否选中，锚点移到它；
 * - Shift 点击：从锚点到它（按屏幕上的行顺序）整段选中；带 Ctrl/⌘ 时追加到已有选择，否则替换。
 * 锚点不在可见行里（所在目录被折叠）时按普通点击处理。
 */

export interface TreeSelection {
  selected: ReadonlySet<string>
  anchor: string | null
}

export const EMPTY_SELECTION: TreeSelection = { selected: new Set(), anchor: null }

/** 可见行顺序里 [anchor, target] 之间（含两端）的路径；任一不在可见行里返回 undefined。 */
export function rangeBetween(order: readonly string[], anchor: string, target: string): string[] | undefined {
  const a = order.indexOf(anchor)
  const b = order.indexOf(target)
  if (a < 0 || b < 0) return undefined
  return order.slice(Math.min(a, b), Math.max(a, b) + 1)
}

/** 根据一次点击（含修饰键）计算新的选择。 */
export function clickSelect(cur: TreeSelection, order: readonly string[], target: string, mods: { toggle: boolean; range: boolean }): TreeSelection {
  if (mods.range && cur.anchor !== null) {
    const span = rangeBetween(order, cur.anchor, target)
    if (span !== undefined) {
      const base = mods.toggle ? new Set(cur.selected) : new Set<string>()
      for (const p of span) base.add(p)
      // Shift 连选不移动锚点：连续 Shift 点击都以同一个起点计算（与 VS Code 一致）。
      return { selected: base, anchor: cur.anchor }
    }
  }
  if (mods.toggle) {
    const next = new Set(cur.selected)
    if (next.has(target)) next.delete(target)
    else next.add(target)
    return { selected: next, anchor: target }
  }
  return { selected: new Set([target]), anchor: target }
}

/** 选择里去掉已不可见 / 已不存在的路径（目录被删除、改名后）。exists 判断某路径是否仍在树里。 */
export function pruneSelection(cur: TreeSelection, exists: (p: string) => boolean): TreeSelection {
  let changed = false
  const next = new Set<string>()
  for (const p of cur.selected) {
    if (exists(p)) next.add(p)
    else changed = true
  }
  const anchor = cur.anchor !== null && exists(cur.anchor) ? cur.anchor : null
  if (!changed && anchor === cur.anchor) return cur
  return { selected: next, anchor }
}
