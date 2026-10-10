/*
 * @Description: 右侧栏「任务」页（kind dshws-tasks，方案 3.7）—— 后台任务 / 子代理（树 · 拓扑图）/ 工作流 / 团队看板
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/TasksTab.tsx
 *
 * 范围是「当前会话所在的任务树」：从当前会话沿父链找到根，根 + 全部子代理。
 * 宿主能力缺失时各区块独立降级（显示「当前 DSH 版本不支持」或隐藏），任何一块出错不影响其余。
 * 页签不可见（切到别的标签 / 窗口在后台）时停止轮询与名册 watch。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import type { WorkflowRunMember, WorkflowRunView } from '../../wire/tasks.js'
import type { SubagentAddress, TasksHost } from './host.js'
import { buildTree, catalogsOf, collectJobRows, flattenTree, isLiveJob, parentsOf, rootAncestor, teamOf, type TaskNode } from './model.js'
import { useJobsSnapshot, useNow, usePoll, useSessionList, useVisible } from './hooks.js'
import { JobsSection } from './JobsSection.js'
import { SubagentSection, type SubagentViewMode } from './SubagentSection.js'
import { WorkflowSection } from './WorkflowSection.js'
import { TeamSection } from './TeamSection.js'
import { IconChevron } from '../sidebar/ui.js'

export interface TasksTabProps {
  t: Translate
  api: WorkspaceApi
  host: TasksHost
  sessionId: string
}

const MODE_KEY = 'dshws.tasks.mode'

function readMode(): SubagentViewMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'graph' ? 'graph' : 'tree'
  } catch {
    return 'tree'
  }
}

function Section(props: { title: string; count?: number; extra?: ReactNode; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(props.defaultOpen ?? true)
  return (
    <section className="dshws-tasks-section" data-open={open}>
      <div className="dshws-tasks-section-head">
        <button type="button" className="dshws-tasks-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
          <IconChevron open={open} />
          <span>{props.title}</span>
          {props.count !== undefined ? <span className="dshws-tasks-count">{props.count}</span> : null}
        </button>
        {open ? props.extra : null}
      </div>
      {open ? props.children : null}
    </section>
  )
}

export function TasksTab(props: TasksTabProps) {
  const { t, api, host, sessionId } = props
  const ref = useRef<HTMLDivElement>(null)
  const visible = useVisible(ref)
  const store = useMemo(() => host.sessionList(), [host])
  const jobs = useMemo(() => host.jobs(), [host])
  const list = useSessionList(store)
  const snapshot = useJobsSnapshot(jobs)
  const [mode, setMode] = useState<SubagentViewMode>(readMode)
  const [openError, setOpenError] = useState<string | null>(null)

  const catalogs = useMemo(() => catalogsOf(list), [list])
  const rootId = useMemo(() => rootAncestor(list, sessionId, parentsOf(list, catalogs)), [list, sessionId, catalogs])
  const tree = useMemo(() => buildTree(list, rootId, catalogs), [list, rootId, catalogs])
  const treeIds = useMemo(() => flattenTree(tree).map((n) => n.id), [tree])
  const treeKey = treeIds.join(',')

  // 名册：页签可见时 watch 任务树内每个会话（宿主对同一会话共享一条流）。
  useEffect(() => {
    if (jobs === undefined || !visible || treeKey === '') return undefined
    const releases: Array<() => void> = []
    for (const id of treeKey.split(',')) {
      try {
        releases.push(jobs.watchRows(id))
      } catch {
        // 单个会话 watch 失败不影响其余。
      }
    }
    return () => {
      for (const r of releases) r()
    }
  }, [jobs, treeKey, visible])
  const jobRows = useMemo(() => collectJobRows(snapshot, list, new Set(treeIds)), [snapshot, list, treeIds])

  const [liveState] = usePoll(() => api.call('tasksSubagentLive', { rootSessionId: rootId }), `live:${rootId}`, visible)
  const [runsState] = usePoll(() => api.call('tasksWorkflowRuns', { rootSessionId: rootId }), `runs:${rootId}`, visible)
  const live = liveState.data?.live ?? {}
  const runs = runsState.data?.runs ?? []
  const team = useMemo(() => teamOf(list, rootId), [list, rootId])
  const anyRunning = runs.some((r) => r.status === 'running') || Object.values(live).some((v) => v.state === 'running')
  const now = useNow(visible && anyRunning)

  const fail = (): void => setOpenError(t('tasks.openUnsupported'))
  const addressOf = (id: string, parentHint?: string): SubagentAddress | undefined => {
    const parent = list.byId[id]?.parentId ?? parentsOf(list, catalogs).get(id) ?? parentHint
    if (parent === undefined) return undefined
    const mode = catalogs.get(parent)?.find((e) => e.id === id)?.mode ?? 'unknown'
    return { parentSessionId: parent, childSessionId: id, mode }
  }
  const openAside = (node: TaskNode): void => {
    setOpenError(null)
    const address = addressOf(node.id, node.parentId)
    if (address === undefined || !(host.openChildAside(address) || host.openChildMain(address))) fail()
  }
  const openMain = (node: TaskNode): void => {
    setOpenError(null)
    if (node.parentId === undefined) {
      if (!host.openSession(node.id)) fail()
      return
    }
    const address = addressOf(node.id, node.parentId)
    if (address === undefined || !host.openChildMain(address)) fail()
  }
  const openMember = (member: WorkflowRunMember, run: WorkflowRunView): void => {
    if (member.childId === '') return
    setOpenError(null)
    const address = addressOf(member.childId, run.originSessionId)
    if (address === undefined || !(host.openChildAside(address) || host.openChildMain(address))) fail()
  }
  const titleOf = (id: string): string => list.byId[id]?.displayTitle ?? id

  const switchMode = (next: SubagentViewMode): void => {
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      /* 隐私模式等：只在本次生效 */
    }
  }

  const liveJobs = jobRows.filter((r) => isLiveJob(r.job)).length
  const unsupported = <div className="dshws-tasks-empty" data-tone="muted">{t('tasks.unsupported')}</div>

  return (
    <div ref={ref} className="dshws-side dshws-tasks">
      <div className="dshws-tasks-scroll">
        {openError !== null ? <div className="dshws-tasks-note" data-tone="warn">{openError}</div> : null}
        <Section title={t('tasks.jobs.title')} count={jobs === undefined ? undefined : liveJobs > 0 ? liveJobs : jobRows.length}>
          {jobs === undefined ? unsupported : <JobsSection t={t} jobs={jobs} rows={jobRows} snapshot={snapshot} rootId={rootId} />}
        </Section>
        <Section
          title={t('tasks.sub.title')}
          count={store === undefined ? undefined : tree.children.length === 0 ? 0 : treeIds.length - 1}
          extra={
            store !== undefined && tree.children.length > 0 ? (
              <span className="dshws-side-seg" role="radiogroup" aria-label={t('tasks.sub.view')}>
                <button type="button" role="radio" aria-checked={mode === 'tree'} data-active={mode === 'tree'} onClick={() => switchMode('tree')}>
                  {t('tasks.sub.tree')}
                </button>
                <button type="button" role="radio" aria-checked={mode === 'graph'} data-active={mode === 'graph'} onClick={() => switchMode('graph')}>
                  {t('tasks.sub.graph')}
                </button>
              </span>
            ) : null
          }
        >
          {store === undefined ? (
            unsupported
          ) : (
            <>
              {liveState.data?.available === false && tree.children.length > 0 ? <div className="dshws-tasks-note">{t('tasks.sub.liveUnavailable')}</div> : null}
              <SubagentSection
                t={t}
                root={tree}
                list={list}
                live={live}
                liveAvailable={liveState.data?.available !== false}
                mode={mode}
                currentSessionId={sessionId}
                now={now}
                onOpen={openAside}
                onOpenMain={openMain}
              />
            </>
          )}
        </Section>
        {runsState.data?.available === false ? (
          <Section title={t('tasks.wf.title')} defaultOpen={false}>{unsupported}</Section>
        ) : runs.length > 0 ? (
          <Section title={t('tasks.wf.title')} count={runs.length}>
            <WorkflowSection t={t} runs={runs} now={now} rootId={rootId} titleOf={titleOf} onOpenMember={openMember} />
          </Section>
        ) : null}
        {team !== undefined ? (
          <Section title={t('tasks.team.title')} count={team.tasks.filter((x) => x.status !== 'deleted').length}>
            <TeamSection t={t} api={api} rootId={rootId} team={team} list={list} live={live} />
          </Section>
        ) : null}
        {liveState.error !== null || runsState.error !== null ? (
          <div className="dshws-tasks-note" data-tone="error">{t('error.generic', { message: liveState.error ?? runsState.error ?? '' })}</div>
        ) : null}
      </div>
    </div>
  )
}
