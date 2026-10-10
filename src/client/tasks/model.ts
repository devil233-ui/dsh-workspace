/*
 * @Description: 任务页的纯数据整理 —— 任务树（根 + 子代理目录）、后台任务行、团队成员状态、时长格式化
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/model.ts
 *
 * 数据全部来自宿主客户端快照（会话列表投影 / ctx.jobs），这里不发请求、不订阅，便于单测。
 */
import type { SubagentLiveView, TeamTaskView } from '../../wire/tasks.js'
import type { CatalogEntry, JobView, JobsSnapshot, SessionListSnapshot, SubagentMode, TeamProjection } from './host.js'

/** 子代理树的深度上限（防御异常数据形成的超深链）。 */
export const TREE_MAX_DEPTH = 32
/** 子代理树的节点上限。 */
export const TREE_MAX_NODES = 500

export interface TaskNode {
  id: string
  /** 树根没有。 */
  parentId?: string
  title: string
  mode: SubagentMode
  createdAt?: number
  depth: number
  children: TaskNode[]
}

/** 各会话的直接子代理目录（来自 projectionsBySession[id].values.subagentCatalog）。 */
export function catalogsOf(list: SessionListSnapshot): Map<string, readonly CatalogEntry[]> {
  const out = new Map<string, readonly CatalogEntry[]>()
  for (const [id, p] of Object.entries(list.projectionsBySession ?? {})) {
    const entries = p?.values?.subagentCatalog
    if (Array.isArray(entries)) out.set(id, entries)
  }
  return out
}

/** 子 → 父：会话摘要里的 parentId 优先，其次从各会话的目录反推（子会话可能还没进会话列表）。 */
export function parentsOf(list: SessionListSnapshot, catalogs = catalogsOf(list)): Map<string, string> {
  const parents = new Map<string, string>()
  for (const [parent, entries] of catalogs) for (const e of entries) if (typeof e.id === 'string') parents.set(e.id, parent)
  for (const s of Object.values(list.byId)) if (s?.parentId !== undefined) parents.set(s.id, s.parentId)
  return parents
}

/** 任务树的根：沿父链一直往上（防环）。 */
export function rootAncestor(list: SessionListSnapshot, sessionId: string, parents = parentsOf(list)): string {
  let id = sessionId
  const seen = new Set([id])
  for (;;) {
    const parent = parents.get(id)
    if (parent === undefined || seen.has(parent)) return id
    seen.add(parent)
    id = parent
  }
}

function titleOf(list: SessionListSnapshot, id: string, label?: string): string {
  const s = list.byId[id]
  // 会话列表给子代理的 displayTitle 在没有标题时就是 id：此时目录里的 label 更有意义。
  const display = s?.displayTitle
  if (display !== undefined && display !== '' && display !== id) return display
  return label !== undefined && label !== '' ? label : (display ?? id)
}

/** 从根展开任务树（按目录顺序；同一会话只出现一次）。 */
export function buildTree(list: SessionListSnapshot, rootId: string, catalogs = catalogsOf(list)): TaskNode {
  const seen = new Set<string>([rootId])
  let count = 1
  const expand = (node: TaskNode): void => {
    if (node.depth >= TREE_MAX_DEPTH) return
    for (const e of catalogs.get(node.id) ?? []) {
      if (typeof e.id !== 'string' || seen.has(e.id) || count >= TREE_MAX_NODES) continue
      seen.add(e.id)
      count += 1
      const child: TaskNode = {
        id: e.id,
        parentId: node.id,
        title: titleOf(list, e.id, e.label),
        mode: e.mode ?? 'unknown',
        ...(typeof e.createdAt === 'number' ? { createdAt: e.createdAt } : {}),
        depth: node.depth + 1,
        children: []
      }
      node.children.push(child)
      expand(child)
    }
  }
  const root: TaskNode = { id: rootId, title: titleOf(list, rootId), mode: 'unknown', depth: 0, children: [] }
  expand(root)
  return root
}

/** 前序展开（树视图逐行渲染）。 */
export function flattenTree(root: TaskNode): TaskNode[] {
  const out: TaskNode[] = []
  const walk = (n: TaskNode): void => {
    out.push(n)
    for (const c of n.children) walk(c)
  }
  walk(root)
  return out
}

/** 子代理是否在运行：实时摘要优先（宿主目录的 activity），其次会话列表的 running。 */
export function isRunning(id: string, live: Record<string, SubagentLiveView | undefined>, list: SessionListSnapshot): boolean {
  const state = live[id]?.state
  if (state !== undefined) return state === 'running'
  return list.byId[id]?.running === true
}

export interface JobRow {
  /** 名册所在的会话（observe / kill 都经它）。 */
  ownerSessionId: string
  ownerTitle: string
  job: JobView
}

export const isLiveJob = (job: JobView): boolean => job.status === 'running' || job.status === 'stopping'

/**
 * 合并任务树内各会话的名册：无主任务会出现在每个被 watch 的会话里，按 id 去重；
 * 归属树外会话的任务丢弃。排序：进行中在前（新的在前），已结束按结束时间倒序。
 */
export function collectJobRows(snapshot: JobsSnapshot, list: SessionListSnapshot, treeIds: ReadonlySet<string>): JobRow[] {
  const rows: JobRow[] = []
  const seen = new Set<string>()
  for (const [watched, jobs] of Object.entries(snapshot.rows)) {
    if (!treeIds.has(watched)) continue
    for (const job of jobs ?? []) {
      if (seen.has(job.id)) continue
      if (job.owner !== undefined && !treeIds.has(job.owner)) continue
      seen.add(job.id)
      const owner = job.owner ?? watched
      rows.push({ ownerSessionId: watched, ownerTitle: titleOf(list, owner), job })
    }
  }
  return rows.sort((a, b) => {
    const la = isLiveJob(a.job)
    const lb = isLiveJob(b.job)
    if (la !== lb) return la ? -1 : 1
    if (la) return b.job.startedAt - a.job.startedAt
    return (b.job.finishedAt ?? b.job.startedAt) - (a.job.finishedAt ?? a.job.startedAt)
  })
}

/** 树根领导的团队看板；没有团队（实验层未加载 / 根不是 Lead）返回 undefined。 */
export function teamOf(list: SessionListSnapshot, rootId: string): TeamProjection | undefined {
  const team = list.projectionsBySession?.[rootId]?.values?.agentTeam
  return team !== undefined && Array.isArray(team.members) && Array.isArray(team.tasks) ? team : undefined
}

export type MemberStatus = 'running' | 'idle' | 'provisioning' | 'failed'

/** 成员状态：持久阶段（失败 / 准备中）优先，其次实时运行标记。 */
export function memberStatus(
  member: TeamProjection['members'][number],
  live: Record<string, SubagentLiveView | undefined>,
  list: SessionListSnapshot
): MemberStatus {
  if (member.phase === 'failed') return 'failed'
  if (member.phase === 'provisioning') return 'provisioning'
  return isRunning(member.id, live, list) ? 'running' : 'idle'
}

/** 看板分列（已删除的不显示）。 */
export function tasksByStatus(tasks: readonly TeamTaskView[]): Record<'pending' | 'in_progress' | 'completed', TeamTaskView[]> {
  const out = { pending: [] as TeamTaskView[], in_progress: [] as TeamTaskView[], completed: [] as TeamTaskView[] }
  for (const t of tasks) if (t.status !== 'deleted') out[t.status].push(t)
  return out
}

/** 时长：45s / 3m 05s / 1h 02m。 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`
}
