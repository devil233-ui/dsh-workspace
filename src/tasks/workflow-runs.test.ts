/*
 * @Description: workflow run 折叠的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/tasks/workflow-runs.test.ts
 */
import { describe, expect, it } from 'vitest'
import { foldWorkflowRuns, mergeWorkflowEvents } from './workflow-runs.js'

const ev = (seq: number, type: string, data: Record<string, unknown>) => ({ type, seq, time: 1000 * seq, data })

describe('foldWorkflowRuns', () => {
  it('四种事件折叠成 run：阶段按首次出现分组，成员 outcome，run-end 定状态', () => {
    const events = [
      ev(1, 'user/message', {}),
      ev(2, 'tool-workflow/run-start', { runId: 'r1', name: 'audit' }),
      ev(3, 'tool-workflow/agent-start', { runId: 'r1', seq: 0, label: 'a', phase: '扫描', childId: 'c0' }),
      ev(4, 'tool-workflow/agent-start', { runId: 'r1', seq: 1, label: 'b', phase: '扫描', childId: 'c1' }),
      ev(5, 'tool-workflow/agent-start', { runId: 'r1', seq: 2, label: '', childId: 'c2' }),
      ev(6, 'tool-workflow/agent-end', { runId: 'r1', seq: 0, outcome: 'completed' }),
      ev(7, 'tool-workflow/agent-end', { runId: 'r1', seq: 1, outcome: 'failed' }),
      ev(8, 'tool-workflow/run-end', { runId: 'r1', stopReason: 'error' }),
      ev(9, 'tool-workflow/run-start', { runId: 'r2', name: '' })
    ]
    const runs = foldWorkflowRuns(events, 's')
    expect(runs).toHaveLength(2)
    const [r1, r2] = runs
    expect(r1).toMatchObject({ runId: 'r1', name: 'audit', originSessionId: 's', status: 'failed', stopReason: 'error', startedSeq: 2, startedAt: 2000, finishedAt: 8000 })
    expect(r1!.phases.map((p) => p.title)).toEqual(['扫描', undefined])
    expect(r1!.phases[0]!.members.map((m) => [m.label, m.outcome])).toEqual([['a', 'completed'], ['b', 'failed']])
    expect(r1!.phases[1]!.members[0]).toEqual({ seq: 2, label: '#2', childId: 'c2' })
    expect(r2).toMatchObject({ runId: 'r2', name: 'r2', status: 'running' })
    expect(r2!.finishedAt).toBeUndefined()
  })

  it('孤儿事件（未知 runId）、重复 start、非法 outcome / stopReason 的处理', () => {
    const runs = foldWorkflowRuns(
      [
        ev(1, 'tool-workflow/agent-start', { runId: 'ghost', seq: 0, label: 'x', childId: 'c' }),
        ev(2, 'tool-workflow/run-start', { runId: 'r', name: 'n' }),
        ev(3, 'tool-workflow/run-start', { runId: 'r', name: 'dup' }),
        ev(4, 'tool-workflow/agent-start', { runId: 'r', seq: 0, label: 'x', childId: 'c' }),
        ev(5, 'tool-workflow/agent-start', { runId: 'r', seq: 0, label: 'dup', childId: 'c' }),
        ev(6, 'tool-workflow/agent-end', { runId: 'r', seq: 0, outcome: 'weird' }),
        ev(7, 'tool-workflow/run-end', { runId: 'r', stopReason: 'weird' })
      ],
      's'
    )
    expect(runs).toHaveLength(1)
    expect(runs[0]!.name).toBe('n')
    expect(runs[0]!.phases[0]!.members).toEqual([{ seq: 0, label: 'x', childId: 'c' }])
    expect(runs[0]!.status).toBe('failed')
    expect(runs[0]!.stopReason).toBeUndefined()
  })

  it('cancelled / completed 映射', () => {
    const fold = (reason: string) => foldWorkflowRuns([ev(1, 'tool-workflow/run-start', { runId: 'r' }), ev(2, 'tool-workflow/run-end', { runId: 'r', stopReason: reason })], 's')[0]!.status
    expect(fold('cancelled')).toBe('cancelled')
    expect(fold('completed')).toBe('completed')
  })
})

describe('mergeWorkflowEvents', () => {
  it('快照与实时镜像按 seq 去重合并，只留 workflow 事件，按 seq 排序', () => {
    const snapshot = [ev(1, 'user/message', {}), ev(2, 'tool-workflow/run-start', { runId: 'r' })]
    const mirrored = [ev(2, 'tool-workflow/run-start', { runId: 'r' }), ev(3, 'tool-workflow/run-end', { runId: 'r', stopReason: 'completed' })]
    const merged = mergeWorkflowEvents(snapshot, mirrored)
    expect(merged.map((e) => e.seq)).toEqual([2, 3])
    expect(foldWorkflowRuns(merged, 's')[0]!.status).toBe('completed')
  })
})
