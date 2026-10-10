/*
 * @Description: 任务页（方案 3.7）的线上数据形状 —— 宿主网关与浏览器共用
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/wire/tasks.ts
 *
 * 本文件会进浏览器 bundle：只放类型与常量，不得 import zod 或任何 node: 模块。
 * 这些数据都依赖宿主内部对象（subagents / agentTeams / agents / 会话事件），
 * 宿主没有时网关返回 available:false（团队写操作返回 reason:'unavailable'），浏览器据此隐藏或提示，不抛错。
 */

/** 子代理当前状态：running = 宿主目录标记为运行中；idle = 未在运行（已结束或等待追问）。 */
export type SubagentState = 'running' | 'idle'

/** 一次工具调用的摘要（最近一次 / 正在执行的那次）。 */
export interface ToolBrief {
  name: string
  /** 参数里最能说明意图的一段（命令、路径、描述…），已压成一行并截断。 */
  detail: string
  /** 已有结果。 */
  settled: boolean
  /** 结果报错。 */
  error?: boolean
}

/** 一个会话（子代理或树根）的实时活动摘要。 */
export interface SubagentLiveView {
  /** 树根没有该字段（宿主目录只给子代理分类，根会话的运行状态浏览器自己知道）。 */
  state?: SubagentState
  /** 最近一次工具调用。 */
  lastTool?: ToolBrief
  /** 最近一段助手文本（截断）。 */
  text?: string
  /** 事件窗口内的工具调用次数。 */
  toolCalls: number
  /** 最近一条事件的时间（epoch ms）。 */
  lastEventTime?: number
}

export interface SubagentLiveResult {
  /** 宿主没有子代理运行时（subagents 服务）时为 false。 */
  available: boolean
  /** 会话 id → 活动摘要（树根 + 全部后代）。 */
  live: Record<string, SubagentLiveView>
}

export type WorkflowAgentOutcome = 'completed' | 'failed' | 'cancelled'
export type WorkflowStopReason = 'completed' | 'cancelled' | 'error'
export type WorkflowRunStatus = 'running' | 'completed' | 'cancelled' | 'failed'

export interface WorkflowRunMember {
  /** 工作流脚本里 agent() 调用的序号（start / end 配对用）。 */
  seq: number
  label: string
  phase?: string
  /** 成员的子会话 id（点击跳转目标）。 */
  childId: string
  /** 结束后才有；运行中没有。 */
  outcome?: WorkflowAgentOutcome
}

export interface WorkflowRunPhase {
  /** undefined = 未分阶段的成员。 */
  title?: string
  members: WorkflowRunMember[]
}

export interface WorkflowRunView {
  runId: string
  name: string
  /** 发起该 run 的会话（事件所在会话）。 */
  originSessionId: string
  status: WorkflowRunStatus
  stopReason?: WorkflowStopReason
  phases: WorkflowRunPhase[]
  /** run-start 事件的 seq（同一会话内排序用）。 */
  startedSeq: number
  startedAt: number
  finishedAt?: number
}

export interface WorkflowRunsResult {
  /** 宿主读不到会话事件（sessions 服务缺失）时为 false。 */
  available: boolean
  runs: WorkflowRunView[]
}

/** 团队看板的任务（宿主 agentTeam 投影的任务视图，字段照搬）。 */
export interface TeamTaskView {
  id: string
  revision: number
  subject: string
  description: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  ownerName?: string
  blockedBy: string[]
  writeScopes: string[]
  ready: boolean
  writeScopeWarnings: string[]
}

/** 浏览器可发起的任务修改动作（宿主 CAS 动作的子集）。 */
export const TEAM_TASK_ACTIONS = ['complete', 'reopen', 'delete', 'edit'] as const
export type TeamTaskAction = (typeof TEAM_TASK_ACTIONS)[number]

export interface TeamTaskCreateInput {
  /** 团队 Lead 会话（= 任务树根）。 */
  rootSessionId: string
  subject: string
  description?: string
}

export interface TeamTaskUpdateInput {
  rootSessionId: string
  taskId: string
  /** 浏览器看到的版本号：宿主按它做 CAS，别人先改过就返回 conflict。 */
  expectedRevision: number
  action: TeamTaskAction
  subject?: string
  description?: string
}

/**
 * 团队写操作结果。失败不抛错而是返回原因，浏览器按原因提示：
 * - unavailable：宿主没有 agentTeams 实验层；
 * - not-live：Lead 会话不在本进程运行（冷会话），无法代表它改看板；
 * - no-team：树根不是团队 Lead；
 * - conflict：任务已被别人改过（revision 过期），刷新后重试；
 * - error：其他被宿主拒绝的情况（message 为宿主原文）。
 */
export type TeamTaskMutationResult =
  | { ok: true; task: TeamTaskView }
  | { ok: false; reason: 'unavailable' | 'not-live' | 'no-team' | 'conflict' | 'error'; message: string }

/** 摘要文本的长度上限（字符）。 */
export const LIVE_TEXT_MAX = 400
export const LIVE_DETAIL_MAX = 160
