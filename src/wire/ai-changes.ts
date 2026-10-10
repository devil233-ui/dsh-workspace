/*
 * @Description: 「AI 改动」视角的线上数据结构（宿主折叠会话事件 → 浏览器 Git 侧栏展示）
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/wire/ai-changes.ts
 *
 * 本文件会被打进浏览器 bundle，只放类型与常量，不得 import node: 模块。
 */

/** 模型对文件做的操作：写入（新建 / 覆盖）、编辑（局部替换）、删除（shell 里的 rm / Remove-Item）。 */
export type AiOpKind = 'write' | 'edit' | 'delete'

export interface AiChangedFile {
  /**
   * 文件的绝对路径，与侧栏工作区路径同一种写法：
   * 远程会话 = 远程 POSIX 绝对路径；本机会话 = 本地 POSIX 形式（/C:/x/a.ts）。
   */
  path: string
  /** 本会话内对它的操作次数（成功或仍在执行的调用；失败的不算）。 */
  ops: number
  /** 最近一个轮次内的操作次数（0 = 本轮没动它）。 */
  turnOps: number
  /** 最近一次操作的类型。 */
  last: AiOpKind
  /** 最近一次操作的事件序号（列表按它倒序）。 */
  lastSeq: number
}

export interface AiChangesResult {
  /** 宿主拿不到该会话的事件（会话服务未就绪 / 会话不存在）。 */
  available: boolean
  /** 最近一个轮次的编号；会话还没有轮次时为 null。 */
  turn: number | null
  /** 按最近操作时间倒序。 */
  files: AiChangedFile[]
}

/** 「改动前内容」：远程写入工具在会话里第一次改某文件前存下的原文（见 agent/preimages.ts）。 */
export interface AiChangeBase {
  /** 改动前文件不存在（本会话新建）。 */
  absent: boolean
  text: string
  binary: boolean
}

/** 单次返回的文件数上限：防止极长会话把整包撑得过大。 */
export const AI_CHANGES_MAX_FILES = 2000
