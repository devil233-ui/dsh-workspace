/*
 * @Description: 任务页「后台任务」抽屉 —— 任务树内的后台任务列表，展开看实时输出，运行中可终止（二次确认）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/JobsSection.tsx
 *
 * 数据全部来自宿主 ctx.jobs：名册 watchRows（页签可见时才 watch）、输出 observe（展开时才观察，
 * 不移动模型的 job_output 读取游标）、终止 kill（宿主照常给模型发「用户终止」完成通知）。
 * 输出宿主已限制在 128K 字符的尾部，这里直接用 <pre> 固定高度滚动，跟随到底部。
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { Translate } from '../context.js'
import type { JobsService, JobsSnapshot } from './host.js'
import { formatDuration, isLiveJob, type JobRow } from './model.js'
import { useNow } from './hooks.js'

/** 输出区「跟随到底部」的阈值：离底部不到这么多像素算在底部。 */
const STICK_PX = 24
/** 终止按钮武装后的确认窗口。 */
const ARM_MS = 3000
/** 已结束任务默认显示条数。 */
const FINISHED_LIMIT = 20

export function JobsSection(props: { t: Translate; jobs: JobsService; rows: JobRow[]; snapshot: JobsSnapshot; rootId: string }) {
  const { t, rows } = props
  const [openId, setOpenId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const anyLive = rows.some((r) => isLiveJob(r.job))
  const now = useNow(anyLive)
  const live = rows.filter((r) => isLiveJob(r.job))
  const finished = rows.filter((r) => !isLiveJob(r.job))
  const shownFinished = showAll ? finished : finished.slice(0, FINISHED_LIMIT)

  if (rows.length === 0) return <div className="dshws-tasks-empty">{t('tasks.jobs.empty')}</div>
  const row = (r: JobRow) => (
    <JobRowView
      key={r.job.id}
      t={t}
      row={r}
      now={now}
      open={openId === r.job.id}
      showOwner={r.job.owner !== undefined && r.job.owner !== props.rootId}
      onToggle={() => setOpenId((cur) => (cur === r.job.id ? null : r.job.id))}
      jobs={props.jobs}
      snapshot={props.snapshot}
    />
  )
  return (
    <div className="dshws-tasks-list">
      {live.map(row)}
      {finished.length > 0 && live.length > 0 ? <div className="dshws-tasks-sub">{t('tasks.jobs.finished', { count: finished.length })}</div> : null}
      {shownFinished.map(row)}
      {!showAll && finished.length > FINISHED_LIMIT ? (
        <button type="button" className="dshws-link-btn dshws-tasks-more" onClick={() => setShowAll(true)}>
          {t('tasks.showAll', { count: finished.length })}
        </button>
      ) : null}
    </div>
  )
}

function JobRowView(props: {
  t: Translate
  row: JobRow
  now: number
  open: boolean
  showOwner: boolean
  onToggle(): void
  jobs: JobsService
  snapshot: JobsSnapshot
}) {
  const { t, row, open } = props
  const job = row.job
  const liveJob = isLiveJob(job)
  const elapsed = (job.finishedAt ?? props.now) - job.startedAt
  return (
    <div className="dshws-job" data-open={open}>
      <button type="button" className="dshws-job-head" onClick={props.onToggle} aria-expanded={open} title={job.label}>
        <span className="dshws-dot" data-state={job.status} />
        <span className="dshws-job-label">{job.label || job.id}</span>
        <span className="dshws-job-meta">
          {job.progress !== undefined && liveJob ? <span className="dshws-job-progress">{job.progress}</span> : null}
          <span className="dshws-pill" data-kind={job.kind}>{job.kind}</span>
          <span className="dshws-job-time">{formatDuration(elapsed)}</span>
        </span>
      </button>
      <div className="dshws-job-sub">
        <span>{t(`tasks.jobs.status.${job.status}`)}</span>
        {job.detail !== undefined && job.detail !== '' ? <span className="dshws-job-detail" data-tone={job.status === 'completed' ? undefined : 'warn'}>{job.detail}</span> : null}
        {props.showOwner ? <span className="dshws-job-owner" title={row.ownerTitle}>{t('tasks.jobs.owner', { name: row.ownerTitle })}</span> : null}
        <span className="dshws-job-id">{job.id}</span>
      </div>
      {open ? <JobOutput t={t} row={row} jobs={props.jobs} snapshot={props.snapshot} /> : null}
    </div>
  )
}

function JobOutput(props: { t: Translate; row: JobRow; jobs: JobsService; snapshot: JobsSnapshot }) {
  const { t, row, jobs } = props
  const job = row.job
  const observed = props.snapshot.observed[job.id]
  const pre = useRef<HTMLPreElement>(null)
  const stick = useRef(true)
  const [armed, setArmed] = useState(false)
  const [killError, setKillError] = useState<string | null>(null)

  // 展开期间观察输出；收起 / 卸载即释放（宿主按引用计数共享同一条流）。
  useEffect(() => {
    try {
      return jobs.observe(row.ownerSessionId, job.id)
    } catch {
      return undefined
    }
  }, [jobs, row.ownerSessionId, job.id])

  useEffect(() => {
    if (!armed) return undefined
    const timer = setTimeout(() => setArmed(false), ARM_MS)
    return () => clearTimeout(timer)
  }, [armed])

  const text = observed?.text ?? ''
  useLayoutEffect(() => {
    const el = pre.current
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight
  }, [text])

  const kill = (): void => {
    if (!armed) {
      setArmed(true)
      return
    }
    setArmed(false)
    setKillError(null)
    jobs.kill(row.ownerSessionId, job.id).catch((error: unknown) => setKillError(error instanceof Error ? error.message : String(error)))
  }

  return (
    <div className="dshws-job-body">
      {observed?.gapBefore === true ? <div className="dshws-tasks-note">{t('tasks.jobs.gap')}</div> : null}
      {observed?.error !== undefined ? <div className="dshws-tasks-note" data-tone="error">{t('tasks.jobs.streamError', { message: observed.error })}</div> : null}
      <pre
        ref={pre}
        className="dshws-job-output"
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_PX
        }}
      >
        {observed === undefined ? t('tasks.jobs.connecting') : text === '' ? t('tasks.jobs.noOutput') : text}
      </pre>
      <div className="dshws-job-actions">
        {observed?.streaming === true ? <span className="dshws-job-streaming">{t('tasks.jobs.streaming')}</span> : <span />}
        {job.status === 'running' ? (
          <button type="button" className="dshws-tasks-btn" data-danger="true" data-armed={armed} onClick={kill}>
            {armed ? t('tasks.jobs.killConfirm') : t('tasks.jobs.kill')}
          </button>
        ) : job.status === 'stopping' ? (
          <span className="dshws-job-streaming">{t('tasks.jobs.status.stopping')}</span>
        ) : null}
      </div>
      {killError !== null ? <div className="dshws-tasks-note" data-tone="error">{t('tasks.jobs.killFailed', { message: killError })}</div> : null}
    </div>
  )
}
