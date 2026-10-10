/*
 * @Description: 「AI 改动」数据在浏览器端的共享轮询（Git 页签正文与标签标题角标共用一份）
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/ai-changes.ts
 *
 * 数据由宿主 aiChanges 折叠会话事件得出（见 agent/ai-changes.ts）。同一会话的多个使用方（正文、标题角标）
 * 共用一个轮询：有人订阅才轮询，最后一个退订即停；页面在后台时不轮询，回到前台 / 获得焦点立即刷新一次。
 */
import { useEffect, useState } from 'react'
import type { WorkspaceApi } from '../api.js'
import type { AiChangedFile, AiChangesResult } from '../../wire/ai-changes.js'

/** 轮询间隔：Agent 写文件后几秒内出现在列表里即可，不必更快（每次宿主都要折叠整段事件）。 */
const POLL_MS = 4000

export type AiScope = 'turn' | 'all'

export interface AiChangesState {
  data: AiChangesResult | null
  error: string | null
}

interface Entry {
  state: AiChangesState
  /** 上次结果的 JSON：内容没变就不通知，列表不闪。 */
  json: string
  refs: number
  listeners: Set<() => void>
  timer: ReturnType<typeof setInterval> | undefined
  inflight: boolean
  off: () => void
}

const entries = new Map<string, Entry>()

async function poll(api: WorkspaceApi, sessionId: string, entry: Entry): Promise<void> {
  if (entry.inflight) return
  entry.inflight = true
  try {
    const data = await api.call('aiChanges', { sessionId })
    const json = JSON.stringify(data)
    if (json === entry.json && entry.state.error === null) return
    entry.json = json
    entry.state = { data, error: null }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    if (entry.state.error === error) return
    entry.state = { data: entry.state.data, error }
  } finally {
    entry.inflight = false
  }
  for (const l of entry.listeners) l()
}

function acquire(api: WorkspaceApi, sessionId: string, listener: () => void): () => void {
  let entry = entries.get(sessionId)
  if (entry === undefined) {
    const e: Entry = { state: { data: null, error: null }, json: '', refs: 0, listeners: new Set(), timer: undefined, inflight: false, off: () => undefined }
    const tick = (): void => {
      if (document.visibilityState === 'visible') void poll(api, sessionId, e)
    }
    e.timer = setInterval(tick, POLL_MS)
    const onFocus = (): void => tick()
    window.addEventListener('focus', onFocus)
    document.addEventListener('visibilitychange', onFocus)
    e.off = () => {
      clearInterval(e.timer)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onFocus)
    }
    void poll(api, sessionId, e)
    entries.set(sessionId, e)
    entry = e
  }
  const current = entry
  current.refs += 1
  current.listeners.add(listener)
  return () => {
    current.listeners.delete(listener)
    current.refs -= 1
    if (current.refs <= 0) {
      current.off()
      entries.delete(sessionId)
    }
  }
}

/** 立即刷新一次（用户点刷新按钮时）。 */
export function refreshAiChanges(api: WorkspaceApi, sessionId: string): void {
  const entry = entries.get(sessionId)
  if (entry !== undefined) void poll(api, sessionId, entry)
}

/** 订阅某会话的 AI 改动；sessionId 为 undefined 时不轮询。 */
export function useAiChanges(api: WorkspaceApi, sessionId: string | undefined): AiChangesState {
  const [, setVersion] = useState(0)
  useEffect(() => {
    if (sessionId === undefined) return
    return acquire(api, sessionId, () => setVersion((v) => v + 1))
  }, [api, sessionId])
  return (sessionId === undefined ? undefined : entries.get(sessionId)?.state) ?? { data: null, error: null }
}

/** 按范围取文件：本轮 = 最近一个轮次里动过的。 */
export function filesInScope(data: AiChangesResult | null, scope: AiScope): AiChangedFile[] {
  if (data === null) return []
  return scope === 'all' ? data.files : data.files.filter((f) => f.turnOps > 0)
}

/** 本轮改动文件数（标签角标）。 */
export function turnCount(data: AiChangesResult | null): number {
  return filesInScope(data, 'turn').length
}

/**
 * 绝对路径（侧栏写法）→ 仓库内相对路径；不在 root 内返回 undefined。
 * 本地 Windows 路径（/C:/x）不区分大小写 —— 模型写的盘符 / 目录大小写可能与 cwd 不一致。
 */
export function repoRelative(root: string, abs: string): string | undefined {
  const base = root.replace(/\/+$/, '')
  const windows = /^\/[A-Za-z]:/.test(base)
  const a = windows ? abs.toLowerCase() : abs
  const b = windows ? base.toLowerCase() : base
  if (!a.startsWith(`${b}/`)) return undefined
  const rel = abs.slice(base.length + 1)
  return rel === '' ? undefined : rel
}
