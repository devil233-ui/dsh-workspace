/*
 * @Description: 任务页「团队看板」—— 读 Lead 会话的 agentTeam 投影（成员 + 任务），写经网关 teamsTaskCreate / teamsTaskUpdate
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/TeamSection.tsx
 *
 * 写操作是 CAS：带上看到的 revision，别人先改过返回 conflict —— 提示「已被修改」，投影刷新后用户再操作即可。
 */
import { useState } from 'react'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import type { SubagentLiveView, TeamTaskAction, TeamTaskMutationResult, TeamTaskView } from '../../wire/tasks.js'
import type { SessionListSnapshot, TeamProjection } from './host.js'
import { memberStatus, tasksByStatus } from './model.js'

const COLUMNS = ['pending', 'in_progress', 'completed'] as const

export function TeamSection(props: {
  t: Translate
  api: WorkspaceApi
  rootId: string
  team: TeamProjection
  list: SessionListSnapshot
  live: Record<string, SubagentLiveView | undefined>
}) {
  const { t, team } = props
  const [subject, setSubject] = useState('')
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<{ tone: 'error' | 'warn' | 'ok'; text: string } | null>(null)
  const [armedDelete, setArmedDelete] = useState<string | null>(null)
  const columns = tasksByStatus(team.tasks)

  const report = (result: TeamTaskMutationResult): void => {
    if (result.ok) {
      setNote(null)
      return
    }
    setNote({ tone: result.reason === 'conflict' ? 'warn' : 'error', text: t(`tasks.team.reason.${result.reason}`, { message: result.message }) })
  }
  const run = (p: Promise<TeamTaskMutationResult>): Promise<boolean> => {
    setBusy(true)
    return p.then(
      (r) => {
        report(r)
        return r.ok
      },
      (error: unknown) => {
        setNote({ tone: 'error', text: t('error.generic', { message: error instanceof Error ? error.message : String(error) }) })
        return false
      }
    ).finally(() => setBusy(false))
  }
  const create = (): void => {
    const s = subject.trim()
    if (s === '') return
    void run(props.api.call('teamsTaskCreate', { rootSessionId: props.rootId, subject: s, ...(description.trim() === '' ? {} : { description }) })).then((ok) => {
      if (!ok) return
      setSubject('')
      setDescription('')
    })
  }
  const update = (task: TeamTaskView, action: TeamTaskAction): void => {
    if (action === 'delete' && armedDelete !== task.id) {
      setArmedDelete(task.id)
      return
    }
    setArmedDelete(null)
    void run(props.api.call('teamsTaskUpdate', { rootSessionId: props.rootId, taskId: task.id, expectedRevision: task.revision, action }))
  }

  return (
    <div className="dshws-team">
      <div className="dshws-team-members">
        {team.members.map((m) => {
          const status = memberStatus(m, props.live, props.list)
          return (
            <span key={m.id} className="dshws-team-member" title={m.error ?? t(`tasks.team.member.${status}`)}>
              <span className="dshws-dot" data-state={status} />
              {m.name}
              {m.role === 'lead' ? <span className="dshws-pill">{t('tasks.team.lead')}</span> : null}
            </span>
          )
        })}
      </div>
      {team.failure !== undefined ? <div className="dshws-tasks-note" data-tone="error">{team.failure}</div> : null}
      <div className="dshws-team-board">
        {COLUMNS.map((col) => (
          <div key={col} className="dshws-team-col">
            <div className="dshws-team-col-title">
              {t(`tasks.team.col.${col}`)} <span className="dshws-tasks-count">{columns[col].length}</span>
            </div>
            {columns[col].map((task) => (
              <div key={task.id} className="dshws-team-task" data-ready={task.ready}>
                <div className="dshws-team-task-subject" title={task.description || task.subject}>{task.subject}</div>
                <div className="dshws-job-sub">
                  <span>#{task.id}</span>
                  {task.ownerName !== undefined ? <span>{t('tasks.team.owner', { name: task.ownerName })}</span> : null}
                  {task.blockedBy.length > 0 ? <span data-tone="warn">{t('tasks.team.blocked', { list: task.blockedBy.join(', ') })}</span> : null}
                </div>
                <div className="dshws-team-actions">
                  {task.status !== 'completed' ? (
                    <button type="button" className="dshws-tasks-btn" disabled={busy} onClick={() => update(task, 'complete')}>{t('tasks.team.complete')}</button>
                  ) : (
                    <button type="button" className="dshws-tasks-btn" disabled={busy} onClick={() => update(task, 'reopen')}>{t('tasks.team.reopen')}</button>
                  )}
                  <button type="button" className="dshws-tasks-btn" data-danger="true" data-armed={armedDelete === task.id} disabled={busy} onClick={() => update(task, 'delete')}>
                    {armedDelete === task.id ? t('tasks.team.deleteConfirm') : t('tasks.team.delete')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>
      <form
        className="dshws-team-form"
        onSubmit={(e) => {
          e.preventDefault()
          create()
        }}
      >
        <input className="dshws-tasks-input" value={subject} maxLength={500} placeholder={t('tasks.team.subject')} onChange={(e) => setSubject(e.target.value)} />
        <textarea className="dshws-tasks-input" value={description} rows={2} placeholder={t('tasks.team.description')} onChange={(e) => setDescription(e.target.value)} />
        <button type="submit" className="dshws-tasks-btn" data-primary="true" disabled={busy || subject.trim() === ''}>{t('tasks.team.create')}</button>
      </form>
      {note !== null ? <div className="dshws-tasks-note" data-tone={note.tone}>{note.text}</div> : null}
    </div>
  )
}
