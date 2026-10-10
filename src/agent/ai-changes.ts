/*
 * @Description: 从会话事件折叠出「模型写入 / 编辑 / 删除了哪些文件」—— Git 侧栏「AI 改动」页签的数据来源
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/agent/ai-changes.ts
 *
 * 为什么在宿主折叠而不是浏览器：宿主客户端的 sessions 服务不暴露事件日志（better-sidebar 也是走宿主路由），
 * 而宿主 deliverables 的「本轮产出」投影只认宿主内置 write / edit / str_replace_editor，
 * 「workspace/changes」又是宿主按本机 git 记录的 —— 远程会话里都不准。
 * 所以这里直接读 tool/call + tool/result：本插件的远程工具与宿主内置工具同名（write / edit / bash），
 * 两种会话共用一套规则。纯函数，路径换算由调用方注入。
 */
import { AI_CHANGES_MAX_FILES, type AiChangedFile, type AiChangesResult, type AiOpKind } from '../wire/ai-changes.js'
import { UPLOAD_TOOL_NAME } from './upload-tool.js'

/** 写入类工具：宿主内置 write、旧名 create、本插件的 upload_to_remote。 */
const WRITE_TOOLS = new Set(['write', 'create', UPLOAD_TOOL_NAME])
/** 编辑类工具。str_replace_editor 按 command 再细分（见 editorKind）。 */
const EDIT_TOOLS = new Set(['edit', 'multi_edit', 'multiedit', 'str_replace', 'apply_patch'])
/** shell 类工具：只从中识别删除命令（rm / Remove-Item），其他写法太多，不猜。 */
const SHELL_TOOLS = new Set(['bash', 'pwsh', 'shell', 'powershell'])

/** 一次涉及文件的调用（折叠的中间结果）。 */
export interface AiOp {
  callId: string
  kind: AiOpKind
  /** 模型原样给出的路径（可能是相对路径）。 */
  paths: string[]
  turn: number | null
  seq: number
}

function isRec(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** tool/call 的 arguments：宿主日志里是 JSON 字符串，测试 / 旧版本可能直接是对象。 */
function argsOf(raw: unknown): Record<string, unknown> {
  if (isRec(raw)) return raw
  if (typeof raw !== 'string') return {}
  try {
    const parsed: unknown = JSON.parse(raw)
    return isRec(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

function pathArg(args: Record<string, unknown>): string | undefined {
  for (const key of ['file_path', 'path', 'filePath', 'target_path']) {
    const v = args[key]
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return undefined
}

/** str_replace_editor：view 只读不算；create 算写入；其余改内容的命令算编辑。 */
function editorKind(args: Record<string, unknown>): AiOpKind | undefined {
  if (args.command === 'create') return 'write'
  if (args.command === 'str_replace' || args.command === 'insert' || args.command === 'undo_edit') return 'edit'
  return undefined
}

/**
 * 按 shell 规则切词（支持单 / 双引号与反斜杠转义），遇到 && || ; | 换行即分段。
 * 只为识别简单的删除命令，复杂语法（子 shell、heredoc）宁可漏掉。
 */
export function shellSegments(command: string, pwsh = false): string[][] {
  const segments: string[][] = []
  let words: string[] = []
  let cur = ''
  let has = false
  let quote: '"' | "'" | null = null
  const endWord = (): void => {
    if (has) words.push(cur)
    cur = ''
    has = false
  }
  const endSegment = (): void => {
    endWord()
    if (words.length > 0) segments.push(words)
    words = []
  }
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i]!
    if (quote !== null) {
      if (ch === quote) quote = null
      else if (!pwsh && ch === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i]
      else cur += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (!pwsh && ch === '\\' && i + 1 < command.length && command[i + 1] !== '\n') {
      cur += command[++i]
      has = true
    } else if (ch === ' ' || ch === '\t') {
      endWord()
    } else if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      endSegment()
    } else {
      cur += ch
      has = true
    }
  }
  endSegment()
  return segments
}

/** 含通配 / 变量 / 命令替换 / 家目录展开的参数无法确定具体文件，不计入。 */
function literalPath(word: string): boolean {
  return word !== '' && !/[*?[\]$`~{}()<>]/.test(word)
}

/** PowerShell 删除命令里带值的参数（其余开关如 -Recurse / -Force 不带值）。 */
const PWSH_VALUE_PARAMS = new Set(['-path', '-literalpath', '-filter', '-include', '-exclude', '-credential', '-stream'])
const PWSH_PATH_PARAMS = new Set(['-path', '-literalpath'])

/**
 * 从一条 shell 命令里找出被删除的文件（rm / unlink / Remove-Item / del / ri / rmdir）。
 * @param pwsh PowerShell 命令：反斜杠是路径分隔符而不是转义符
 */
export function deletedPaths(command: string, pwsh = false): string[] {
  const out: string[] = []
  for (const seg of shellSegments(command, pwsh)) {
    // 重定向（> /dev/null、2>&1）的目标不是被删的文件：连同目标一起去掉。
    let words: string[] = []
    for (let i = 0; i < seg.length; i += 1) {
      const w = seg[i]!
      if (/^\d*(>>?|<)$/.test(w)) i += 1
      else if (!/[<>]/.test(w)) words.push(w)
    }
    while (words.length > 0 && (words[0] === 'sudo' || words[0] === 'command' || /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[0]!))) words = words.slice(1)
    const head = (words[0] ?? '').toLowerCase()
    const args = words.slice(1)
    if (head === 'rm' || head === 'unlink' || head === 'rmdir') {
      let flagsDone = false
      for (const a of args) {
        if (!flagsDone && a === '--') flagsDone = true
        else if (!flagsDone && a.startsWith('-') && a.length > 1) continue
        else if (literalPath(a)) out.push(a)
      }
    } else if (head === 'remove-item' || head === 'ri' || head === 'del' || head === 'erase' || head === 'rd') {
      for (let i = 0; i < args.length; i += 1) {
        const a = args[i]!
        const lower = a.toLowerCase()
        if (lower.startsWith('-')) {
          if (PWSH_VALUE_PARAMS.has(lower)) {
            const value = args[i + 1]
            i += 1
            if (PWSH_PATH_PARAMS.has(lower) && value !== undefined) out.push(...value.split(',').filter(literalPath))
          }
          continue
        }
        // cmd 风格开关（del /f /q）
        if (/^\/[a-z]$/i.test(a)) continue
        out.push(...a.split(',').filter(literalPath))
      }
    }
  }
  return out
}

/** tool/result 是否报错：0.1.7 起错误标记在 message 上，0.1.6 在 tool-result 包装块上（两种日志都要认）。 */
function resultIsError(message: Record<string, unknown>): boolean {
  if (message.isError === true) return true
  if (Array.isArray(message.content)) {
    for (const block of message.content) {
      if (isRec(block) && block.type === 'tool-result') return block.isError === true
    }
  }
  return false
}

/** 一次 tool/call 涉及的文件操作；不涉及文件返回 undefined。 */
function opOfCall(name: string, rawArgs: unknown): { kind: AiOpKind; paths: string[] } | undefined {
  const args = argsOf(rawArgs)
  if (SHELL_TOOLS.has(name)) {
    const command = args.command
    if (typeof command !== 'string') return undefined
    const paths = deletedPaths(command, name === 'pwsh' || name === 'powershell')
    return paths.length > 0 ? { kind: 'delete', paths } : undefined
  }
  const p = pathArg(args)
  if (p === undefined) return undefined
  if (name === 'str_replace_editor') {
    const kind = editorKind(args)
    return kind === undefined ? undefined : { kind, paths: [p] }
  }
  if (WRITE_TOOLS.has(name)) return { kind: 'write', paths: [p] }
  if (EDIT_TOOLS.has(name)) return { kind: 'edit', paths: [p] }
  return undefined
}

/**
 * 折叠事件为文件操作列表（按事件顺序）。tool/call 记下操作，对应的 tool/result 报错则剔除；
 * 还没有结果的调用（正在执行）保留 —— 写入往往在结果返回前就已落盘。
 */
export function extractAiOps(events: readonly unknown[]): { ops: AiOp[]; turn: number | null } {
  const byCall = new Map<string, AiOp>()
  let turn: number | null = null
  const seeTurn = (t: unknown): void => {
    if (typeof t === 'number' && Number.isSafeInteger(t) && (turn === null || t > turn)) turn = t
  }
  for (let i = 0; i < events.length; i += 1) {
    const event = events[i]
    if (!isRec(event) || !isRec(event.data)) continue
    const data = event.data
    const seq = typeof event.seq === 'number' ? event.seq : i
    if (event.type === 'turn/start') {
      seeTurn(data.turn)
    } else if (event.type === 'tool/call') {
      seeTurn(data.turn)
      if (typeof data.name !== 'string' || typeof data.callId !== 'string') continue
      const op = opOfCall(data.name, data.arguments)
      if (op === undefined) continue
      byCall.set(data.callId, { callId: data.callId, ...op, turn: typeof data.turn === 'number' ? data.turn : null, seq })
    } else if (event.type === 'tool/result') {
      const message = data.message
      if (!isRec(message) || !isRec(message.source)) continue
      const callId = message.source.callId
      if (typeof callId === 'string' && byCall.has(callId) && resultIsError(message)) byCall.delete(callId)
    }
  }
  return { ops: [...byCall.values()].sort((a, b) => a.seq - b.seq), turn }
}

/**
 * 会话事件 → 按文件聚合的改动列表。
 * @param resolve 模型给出的路径 → 绝对路径（侧栏写法）；不属于本会话工作区 / 无法解析时返回 undefined（不计入）
 */
export function foldAiChanges(events: readonly unknown[], resolve: (raw: string) => string | undefined): AiChangesResult {
  const { ops, turn } = extractAiOps(events)
  const files = new Map<string, AiChangedFile>()
  for (const op of ops) {
    for (const raw of op.paths) {
      const abs = resolve(raw)
      if (abs === undefined) continue
      const inTurn = turn !== null && op.turn === turn ? 1 : 0
      const prev = files.get(abs)
      files.set(abs, {
        path: abs,
        ops: (prev?.ops ?? 0) + 1,
        turnOps: (prev?.turnOps ?? 0) + inTurn,
        last: op.kind,
        lastSeq: op.seq
      })
    }
  }
  const list = [...files.values()].sort((a, b) => b.lastSeq - a.lastSeq).slice(0, AI_CHANGES_MAX_FILES)
  return { available: true, turn, files: list }
}
