/*
 * @Description: 侧边对话 —— 「会话第一轮进行中、暂无已完成轮次」的判定与记忆（分叉按钮据此禁用）
 * @Author: YangHeng
 * @Date: 2026-10-10 21:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/fork-pending.ts
 *
 * 为什么需要它：宿主会话摘要的 blank 在 turn/start 时就变 false，但分叉（省略 atSeq）要求至少一个已完成轮次
 * （turn/end），摘要里没有「已完成轮次数」之类的可靠字段。所以只能在分叉报 fork-unavailable 时记住该会话，
 * 在它 running 期间禁用按钮；running 变 false（第一轮结束）就自动清除恢复。
 */
import type { Translate } from '../context.js'
import type { SessionListSnapshot, SessionListStore, SessionSummary } from '../tasks/host.js'

/** 宿主分叉错误是否为「没有已完成轮次可分叉」（session/fork-unavailable）。 */
export function isForkUnavailable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes('fork-unavailable')
}

/** 分叉失败的提示文案：暂无已完成轮次给友好文案，其他错误照原样显示宿主报错。 */
export function forkErrorText(error: unknown, t: Translate): string {
  if (isForkUnavailable(error)) return t('sidechat.waitTurn')
  return t('sidechat.forkFailed', { message: error instanceof Error ? error.message : String(error) })
}

/** 该会话当前是否应禁用分叉：已记住「暂无已完成轮次」且仍在运行。 */
export function forkBlocked(pending: ReadonlySet<string>, summary: SessionSummary | undefined): boolean {
  return summary !== undefined && pending.has(summary.id) && summary.running === true
}

/** 去掉已不在运行的会话（第一轮结束 → 有已完成轮次了）；没有变化时返回原集合，便于外部按引用判等。 */
export function prunePending(pending: ReadonlySet<string>, list: SessionListSnapshot): ReadonlySet<string> {
  let next: Set<string> | undefined
  for (const id of pending) {
    if (list.byId[id]?.running === true) continue
    next ??= new Set(pending)
    next.delete(id)
  }
  return next ?? pending
}

export interface ForkPendingStore {
  getSnapshot(): ReadonlySet<string>
  subscribe(listener: () => void): () => void
  /** 记住 id「暂无已完成轮次」；返回是否记住（会话已不在运行就不记，用户直接重试即可）。 */
  mark(id: string, list: SessionListStore | undefined): boolean
}

export function createForkPendingStore(): ForkPendingStore {
  let pending: ReadonlySet<string> = new Set()
  let watched: { list: SessionListStore; off: () => void } | undefined
  const listeners = new Set<() => void>()
  const set = (next: ReadonlySet<string>): void => {
    if (next === pending) return
    pending = next
    // 为什么在 store 里订阅会话列表而不是靠组件渲染时清理：running 变 false 时按钮所在组件可能没挂载，
    // 记录残留会让之后的第二轮运行期间被误禁用。集合清空就退订，不常驻监听。
    if (pending.size === 0 && watched !== undefined) {
      watched.off()
      watched = undefined
    }
    for (const l of listeners) l()
  }
  return {
    getSnapshot: () => pending,
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    mark(id, list) {
      if (list === undefined || list.getSnapshot()?.byId[id]?.running !== true) return false
      if (watched === undefined || watched.list !== list) {
        watched?.off()
        const off = list.subscribe(() => set(prunePending(pending, list.getSnapshot() ?? { byId: {} })))
        watched = { list, off }
      }
      if (!pending.has(id)) set(new Set([...pending, id]))
      return true
    }
  }
}

/** 线程页与页头按钮共用一份记忆（同一会话两处入口状态一致）。 */
export const forkPending = createForkPendingStore()
