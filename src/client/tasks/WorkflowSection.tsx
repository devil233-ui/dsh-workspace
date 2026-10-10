/*
 * @Description: 任务页「工作流」—— 任务树内各会话发起的 workflow run：状态、时长、按阶段分组的成员（点成员打开其子代理）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/WorkflowSection.tsx
 */
import { useState } from 'react'
import type { Translate } from '../context.js'
import type { WorkflowRunMember, WorkflowRunView } from '../../wire/tasks.js'
import { formatDuration } from './model.js'

/** 默认展开最近几个 run；更早的折叠成「显示全部」。 */
const RECENT = 5

export function WorkflowSection(props: {
  t: Translate
  runs: WorkflowRunView[]
  now: number
  rootId: string
  titleOf(sessionId: string): string
  onOpenMember(member: WorkflowRunMember, run: WorkflowRunView): void
}) {
  const { t } = props
  const [showAll, setShowAll] = useState(false)
  if (props.runs.length === 0) return <div className="dshws-tasks-empty">{t('tasks.wf.empty')}</div>
  // 新的在前。
  const ordered = [...props.runs].reverse()
  const shown = showAll ? ordered : ordered.slice(0, RECENT)
  return (
    <div className="dshws-tasks-list">
      {shown.map((run) => {
        const members = run.phases.flatMap((p) => p.members)
        const done = members.filter((m) => m.outcome !== undefined).length
        const elapsed = (run.finishedAt ?? props.now) - run.startedAt
        return (
          <div key={`${run.originSessionId}:${run.runId}`} className="dshws-wf">
            <div className="dshws-wf-head">
              <span className="dshws-dot" data-state={run.status} />
              <span className="dshws-wf-name" title={run.runId}>{run.name}</span>
              <span className="dshws-pill" data-state={run.status}>{t(`tasks.wf.status.${run.status}`)}</span>
              <span className="dshws-job-time">{t('tasks.wf.progress', { done, total: members.length })} · {formatDuration(elapsed)}</span>
            </div>
            {run.originSessionId !== props.rootId ? <div className="dshws-job-sub">{t('tasks.wf.origin', { name: props.titleOf(run.originSessionId) })}</div> : null}
            {run.phases.map((phase, i) => (
              <div key={phase.title ?? `#${i}`} className="dshws-wf-phase">
                {phase.title !== undefined ? <div className="dshws-wf-phase-title">{phase.title}</div> : null}
                <div className="dshws-wf-members">
                  {phase.members.map((m) => (
                    <button
                      key={m.seq}
                      type="button"
                      className="dshws-wf-member"
                      data-outcome={m.outcome ?? 'running'}
                      disabled={m.childId === ''}
                      title={`${m.label} · ${t(`tasks.wf.outcome.${m.outcome ?? 'running'}`)}`}
                      onClick={() => props.onOpenMember(m, run)}
                    >
                      <span className="dshws-dot" data-state={m.outcome ?? 'running'} />
                      <span>{m.label}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )
      })}
      {!showAll && ordered.length > RECENT ? (
        <button type="button" className="dshws-link-btn dshws-tasks-more" onClick={() => setShowAll(true)}>
          {t('tasks.showAll', { count: ordered.length })}
        </button>
      ) : null}
    </div>
  )
}
