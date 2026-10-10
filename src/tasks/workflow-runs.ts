/*
 * @Description: 从会话事件折叠出工作流 run（tool-workflow/* 四种事件）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/tasks/workflow-runs.ts
 *
 * 宿主 dsh-tool-workflow 只往「发起调用的 Agent 的会话」追加四种事件（嵌套 run 不记录）：
 * - tool-workflow/run-start   { runId, name }
 * - tool-workflow/agent-start { runId, seq, label, phase?, childId }
 * - tool-workflow/agent-end   { runId, seq, outcome }
 * - tool-workflow/run-end     { runId, stopReason }
 * 宿主官方面板 dsh-client-ui-workflow-run 在浏览器折叠同样的事件；这里在宿主折叠，供任务页把 run 挂到发起它的会话下。
 * 引用了未知 runId 的事件（窗口从 run 中途开始 / 尾部损坏）直接跳过。纯函数，便于单测。
 */
import type { WorkflowRunMember, WorkflowRunView } from '../wire/tasks.js'
import { asEvent, type SessionEventLike } from '../host-internal/index.js'

const PREFIX = 'tool-workflow/'

interface Fold {
  view: WorkflowRunView
  bySeq: Map<number, WorkflowRunMember>
}

function seqOf(data: Record<string, unknown>): number | undefined {
  const seq = data.seq
  return typeof seq === 'number' && Number.isSafeInteger(seq) && seq >= 0 ? seq : undefined
}

/** 只挑出 tool-workflow/* 事件（并收窄结构）。 */
export function workflowEventsOf(events: readonly unknown[]): SessionEventLike[] {
  const out: SessionEventLike[] = []
  for (const raw of events) {
    // 先做廉价的前缀判断：长会话里绝大多数事件都不是 workflow 事件。
    const type = (raw as { type?: unknown } | null)?.type
    if (typeof type !== 'string' || !type.startsWith(PREFIX)) continue
    const e = asEvent(raw)
    if (e !== undefined) out.push(e)
  }
  return out
}

/**
 * 折叠一个会话的 workflow run（按 run-start 顺序）。
 * @param events 会话事件（旧 → 新）
 * @param originSessionId 事件所在会话
 */
export function foldWorkflowRuns(events: readonly unknown[], originSessionId: string): WorkflowRunView[] {
  const runs: Fold[] = []
  const byId = new Map<string, Fold>()
  const runOf = (data: Record<string, unknown>): Fold | undefined => (typeof data.runId === 'string' ? byId.get(data.runId) : undefined)
  for (const e of workflowEventsOf(events)) {
    const data = e.data
    if (e.type === 'tool-workflow/run-start') {
      const runId = typeof data.runId === 'string' ? data.runId : undefined
      if (runId === undefined || byId.has(runId)) continue
      const fold: Fold = {
        view: {
          runId,
          name: typeof data.name === 'string' && data.name !== '' ? data.name : runId,
          originSessionId,
          status: 'running',
          phases: [],
          startedSeq: e.seq,
          startedAt: e.time
        },
        bySeq: new Map()
      }
      byId.set(runId, fold)
      runs.push(fold)
    } else if (e.type === 'tool-workflow/agent-start') {
      const fold = runOf(data)
      const seq = seqOf(data)
      if (fold === undefined || seq === undefined || fold.bySeq.has(seq)) continue
      const member: WorkflowRunMember = {
        seq,
        label: typeof data.label === 'string' && data.label !== '' ? data.label : `#${seq}`,
        ...(typeof data.phase === 'string' && data.phase !== '' ? { phase: data.phase } : {}),
        childId: typeof data.childId === 'string' ? data.childId : ''
      }
      fold.bySeq.set(seq, member)
      // 阶段按首次出现的顺序分组；未分阶段的成员共用一组。
      let phase = fold.view.phases.find((p) => p.title === member.phase)
      if (phase === undefined) {
        phase = member.phase === undefined ? { members: [] } : { title: member.phase, members: [] }
        fold.view.phases.push(phase)
      }
      phase.members.push(member)
    } else if (e.type === 'tool-workflow/agent-end') {
      const member = runOf(data)?.bySeq.get(seqOf(data) ?? -1)
      const outcome = data.outcome
      if (member !== undefined && (outcome === 'completed' || outcome === 'failed' || outcome === 'cancelled')) member.outcome = outcome
    } else if (e.type === 'tool-workflow/run-end') {
      const fold = runOf(data)
      if (fold === undefined) continue
      const reason = data.stopReason
      if (reason === 'completed' || reason === 'cancelled' || reason === 'error') {
        fold.view.stopReason = reason
        fold.view.status = reason === 'error' ? 'failed' : reason
      } else {
        fold.view.status = 'failed'
      }
      fold.view.finishedAt = e.time
    }
  }
  return runs.map((f) => f.view)
}

/**
 * 合并快照与实时镜像（按 seq 去重）后折叠：宿主重启后的会话快照可能落后于实时事件，
 * 同一事件两边都有时只算一次。seq 缺失（-1）的镜像事件无法去重，直接丢弃。
 */
export function mergeWorkflowEvents(snapshot: readonly unknown[], mirrored: readonly SessionEventLike[]): SessionEventLike[] {
  const bySeq = new Map<number, SessionEventLike>()
  for (const e of workflowEventsOf(snapshot)) bySeq.set(e.seq, e)
  for (const e of mirrored) if (e.seq >= 0) bySeq.set(e.seq, e)
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq)
}
