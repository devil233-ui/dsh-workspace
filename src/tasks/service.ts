/*
 * @Description: 任务页的宿主端数据：子代理实时活动摘要、任务树的工作流 run（网关 tasksSubagentLive / tasksWorkflowRuns 的实现）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/tasks/service.ts
 *
 * 宿主内部对象全部经 host-internal 访问；缺失时返回 available:false，某个会话读不了只跳过它，不影响整批。
 */
import type { SubagentLiveResult, SubagentLiveView, WorkflowRunView, WorkflowRunsResult } from '../wire/tasks.js'
import type { HostInternal } from '../host-internal/index.js'
import { foldActivity } from './subagent-activity.js'
import { foldWorkflowRuns, mergeWorkflowEvents } from './workflow-runs.js'

/** 一次最多折叠多少个子会话（超大的子代理树只报前面这些，避免一次请求扫上百份日志）。 */
export const LIVE_MAX_SESSIONS = 200

/**
 * 任务树每个会话的活动摘要。树根没有 state（宿主目录不给根分类，浏览器从会话列表自己知道）。
 * 子会话的 running 取宿主目录的 activity；diagnostic 行（坏子会话）不报。
 */
export async function subagentLive(internal: HostInternal | undefined, rootSessionId: string): Promise<SubagentLiveResult> {
  if (internal === undefined || !internal.hasSubagents()) return { available: false, live: {} }
  const descendants = await internal.listDescendants(rootSessionId)
  if (descendants === undefined) return { available: false, live: {} }
  const live: Record<string, SubagentLiveView> = {}
  const foldInto = (sessionId: string, running: boolean | undefined): void => {
    const view: SubagentLiveView = { ...(running === undefined ? {} : { state: running ? 'running' : 'idle' }), toolCalls: 0 }
    try {
      const events = internal.liveEvents(sessionId)
      if (events !== undefined) Object.assign(view, foldActivity(events, { live: running !== false }))
    } catch {
      // 某个会话的日志读不了：保留这一行（运行状态来自目录），只是没有细节。
    }
    live[sessionId] = view
  }
  foldInto(rootSessionId, undefined)
  let count = 0
  for (const entry of descendants) {
    if (entry.kind !== 'child') continue
    if (++count > LIVE_MAX_SESSIONS) break
    foldInto(entry.id, entry.activity === 'running')
  }
  return { available: true, live }
}

/**
 * 任务树内各会话发起的工作流 run（旧 → 新）。没有子代理运行时也照样折叠树根自己（退化成只有一个节点的树）。
 * @param cold 冷会话（不在内存）的事件读取：只用于树根 —— 子会话逐个冷读太贵，且子会话的 run 很少见
 */
export async function workflowRuns(
  internal: HostInternal | undefined,
  rootSessionId: string,
  cold?: (sessionId: string) => Promise<readonly unknown[] | undefined>
): Promise<WorkflowRunsResult> {
  if (internal === undefined || !internal.hasSessionEvents()) return { available: false, runs: [] }
  const ids = [rootSessionId]
  const descendants = await internal.listDescendants(rootSessionId)
  for (const d of descendants ?? []) if (d.kind === 'child' && ids.length <= LIVE_MAX_SESSIONS) ids.push(d.id)
  const runs: WorkflowRunView[] = []
  for (const id of ids) {
    try {
      let snapshot = internal.liveEvents(id)
      if (snapshot === undefined && id === rootSessionId && cold !== undefined) snapshot = await cold(id)
      const merged = mergeWorkflowEvents(snapshot ?? [], internal.mirroredWorkflowEvents(id))
      if (merged.length > 0) runs.push(...foldWorkflowRuns(merged, id))
    } catch {
      // 一个会话折叠失败只跳过它。
    }
  }
  // 跨会话没有统一的 seq：按开始时间排，同一时刻再按 seq。
  runs.sort((a, b) => a.startedAt - b.startedAt || a.startedSeq - b.startedSeq)
  return { available: true, runs }
}
