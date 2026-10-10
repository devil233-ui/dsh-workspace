/*
 * @Description: 团队看板写操作 —— 代表任务树根（Lead）调宿主 agentTeams.createTask / updateTask，并把拒绝原因映射成线上结果
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/host-internal/teams.ts
 *
 * 为什么必须在宿主做：createTask / updateTask 要求传入「活着的 Lead Agent」作为身份凭据，只有宿主进程持有。
 * 读看板不经这里（浏览器直接读会话投影 agentTeam）。
 * 宿主拒绝时抛 TeamError（code 字段），revision 过期是 TEAM_TASK_STALE_REVISION —— 只认 code，不解析 message。
 */
import type { TeamTaskCreateInput, TeamTaskMutationResult, TeamTaskUpdateInput, TeamTaskView } from '../wire/tasks.js'
import type { HostInternal } from './index.js'

const STALE_REVISION = 'TEAM_TASK_STALE_REVISION'

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function codeOf(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' ? code : undefined
}

/** 宿主返回的任务视图 → 线上形状（缺字段补默认值，防止实验层字段漂移把浏览器弄崩）。 */
export function toTaskView(raw: unknown): TeamTaskView {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>
  const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
  const status = r.status
  return {
    id: typeof r.id === 'string' ? r.id : '',
    revision: typeof r.revision === 'number' ? r.revision : 0,
    subject: typeof r.subject === 'string' ? r.subject : '',
    description: typeof r.description === 'string' ? r.description : '',
    status: status === 'in_progress' || status === 'completed' || status === 'deleted' ? status : 'pending',
    ...(typeof r.ownerName === 'string' ? { ownerName: r.ownerName } : {}),
    blockedBy: strings(r.blockedBy),
    writeScopes: strings(r.writeScopes),
    ready: r.ready === true,
    writeScopeWarnings: strings(r.writeScopeWarnings)
  }
}

type Membership = { ok: true; svc: NonNullable<ReturnType<HostInternal['agentTeams']>>; agent: unknown } | Extract<TeamTaskMutationResult, { ok: false }>

function membership(internal: HostInternal | undefined, rootSessionId: string): Membership {
  const svc = internal?.agentTeams()
  if (internal === undefined || svc === undefined) return { ok: false, reason: 'unavailable', message: 'agent-teams layer is not mounted' }
  const agent = internal.liveAgent(rootSessionId)
  // 团队由活着的 Lead 驱动：冷会话（未加载 / 在别的进程）无法代表它改看板。
  if (agent === undefined) return { ok: false, reason: 'not-live', message: 'the lead session is not live in this process' }
  try {
    if (svc.tryMembership(agent) === undefined) return { ok: false, reason: 'no-team', message: 'the session leads no team' }
  } catch (error) {
    return { ok: false, reason: 'no-team', message: messageOf(error) }
  }
  return { ok: true, svc, agent }
}

function rejection(error: unknown): TeamTaskMutationResult {
  return { ok: false, reason: codeOf(error) === STALE_REVISION ? 'conflict' : 'error', message: messageOf(error) }
}

export async function createTeamTask(internal: HostInternal | undefined, input: TeamTaskCreateInput): Promise<TeamTaskMutationResult> {
  const m = membership(internal, input.rootSessionId)
  if (!m.ok) return m
  try {
    const task = await m.svc.createTask(m.agent, { subject: input.subject, description: input.description ?? '' })
    return { ok: true, task: toTaskView(task) }
  } catch (error) {
    return rejection(error)
  }
}

export async function updateTeamTask(internal: HostInternal | undefined, input: TeamTaskUpdateInput): Promise<TeamTaskMutationResult> {
  const m = membership(internal, input.rootSessionId)
  if (!m.ok) return m
  const request: Record<string, unknown> = { taskId: input.taskId, expectedRevision: input.expectedRevision, action: input.action }
  if (input.subject !== undefined) request.subject = input.subject
  if (input.description !== undefined) request.description = input.description
  try {
    return { ok: true, task: toTaskView(await m.svc.updateTask(m.agent, request)) }
  } catch (error) {
    return rejection(error)
  }
}
