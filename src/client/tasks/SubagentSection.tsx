/*
 * @Description: 任务页「子代理」—— 树视图 / 拓扑图视图（自绘分层 DAG，SVG）切换，节点带实时活动摘要
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/SubagentSection.tsx
 *
 * 树结构来自会话列表投影 subagentCatalog（浏览器直读），活动摘要来自网关 tasksSubagentLive（宿主折叠事件）。
 * 点击子代理 = 在右侧栏打开它的对话（宿主 subagentchat 资源）；「↗」= 在主区打开。树根点击回到主会话。
 */
import { useMemo } from 'react'
import type { Translate } from '../context.js'
import type { SubagentLiveView } from '../../wire/tasks.js'
import type { SessionListSnapshot } from './host.js'
import { flattenTree, formatDuration, isRunning, type TaskNode } from './model.js'
import { layoutDag } from './dag.js'

export type SubagentViewMode = 'tree' | 'graph'

export interface SubagentSectionProps {
  t: Translate
  root: TaskNode
  list: SessionListSnapshot
  live: Record<string, SubagentLiveView | undefined>
  /** 网关不可用（宿主没有子代理运行时）：只显示结构，不显示活动摘要。 */
  liveAvailable: boolean
  mode: SubagentViewMode
  currentSessionId: string
  now: number
  onOpen(node: TaskNode): void
  onOpenMain(node: TaskNode): void
}

/** 节点的一行活动说明：运行中的工具 > 最近文本 > 最近工具。 */
export function activityLine(t: Translate, view: SubagentLiveView | undefined, running: boolean): string {
  if (view === undefined) return ''
  const tool = view.lastTool
  if (running && tool !== undefined && !tool.settled) return t('tasks.sub.running', { name: tool.name, detail: tool.detail })
  if (view.text !== undefined) return view.text
  if (tool !== undefined) return t(tool.error === true ? 'tasks.sub.lastToolError' : 'tasks.sub.lastTool', { name: tool.name, detail: tool.detail })
  return ''
}

export function SubagentSection(props: SubagentSectionProps) {
  const { t, root } = props
  if (root.children.length === 0) return <div className="dshws-tasks-empty">{t('tasks.sub.empty')}</div>
  return props.mode === 'graph' ? <SubagentGraph {...props} /> : <SubagentTree {...props} />
}

function SubagentTree(props: SubagentSectionProps) {
  const { t, list, live, now } = props
  const rows = useMemo(() => flattenTree(props.root), [props.root])
  return (
    <div className="dshws-tasks-list">
      {rows.map((node) => {
        const isRoot = node.parentId === undefined
        const running = isRunning(node.id, live, list)
        const view = live[node.id]
        const line = activityLine(t, view, running)
        const age = view?.lastEventTime !== undefined ? formatDuration(now - view.lastEventTime) : undefined
        return (
          <div key={node.id} className="dshws-sub-row" data-current={node.id === props.currentSessionId} style={{ paddingLeft: 8 + Math.min(node.depth, 12) * 14 }}>
            <button
              type="button"
              className="dshws-sub-main"
              title={isRoot ? t('tasks.sub.openRoot') : t('tasks.sub.openAside')}
              onClick={() => (isRoot ? props.onOpenMain(node) : props.onOpen(node))}
            >
              <span className="dshws-dot" data-state={running ? 'running' : 'idle'} />
              <span className="dshws-sub-title">{isRoot ? t('tasks.sub.root', { title: node.title }) : node.title}</span>
              {!isRoot && node.mode !== 'unknown' ? <span className="dshws-pill">{t(`tasks.sub.mode.${node.mode}`)}</span> : null}
              {view !== undefined && view.toolCalls > 0 ? <span className="dshws-sub-count" title={t('tasks.sub.toolCalls', { count: view.toolCalls })}>×{view.toolCalls}</span> : null}
              {age !== undefined ? <span className="dshws-job-time" title={t('tasks.sub.lastEvent')}>{t('tasks.ago', { time: age })}</span> : null}
            </button>
            {!isRoot ? (
              <button type="button" className="dshws-ibtn dshws-sub-jump" title={t('tasks.sub.openMain')} aria-label={t('tasks.sub.openMain')} onClick={() => props.onOpenMain(node)}>
                ↗
              </button>
            ) : null}
            {line !== '' ? <div className="dshws-sub-line" data-running={running}>{line}</div> : null}
          </div>
        )
      })}
    </div>
  )
}

const NODE_W = 150
const NODE_H = 44

/**
 * 按显示宽度截断（SVG text 不会自动省略）：全角字符记 2 个单位、其余记 1 个，超出 units 时以「…」结尾。
 * 按字符数截断时中文会溢出节点框（中文宽度约是英文的两倍）。
 */
export function ellipsis(text: string, units: number): string {
  let used = 0
  const chars = Array.from(text)
  for (let i = 0; i < chars.length; i += 1) {
    used += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]|[\u{1f300}-\u{1faff}]/u.test(chars[i]!) ? 2 : 1
    if (used > units) return `${chars.slice(0, Math.max(0, i - 1)).join('')}…`
  }
  return text
}

function SubagentGraph(props: SubagentSectionProps) {
  const { t, list, live } = props
  const nodes = useMemo(() => flattenTree(props.root), [props.root])
  const layout = useMemo(
    () =>
      layoutDag(
        nodes.map((n) => n.id),
        nodes.filter((n) => n.parentId !== undefined).map((n) => ({ from: n.parentId as string, to: n.id })),
        { nodeWidth: NODE_W, nodeHeight: NODE_H }
      ),
    [nodes]
  )
  return (
    <div className="dshws-dag-wrap">
      <svg className="dshws-dag" width={layout.width} height={layout.height} viewBox={`0 0 ${layout.width} ${layout.height}`} role="img" aria-label={t('tasks.sub.graph')}>
        {layout.edges.map((e) => {
          const a = layout.nodes[e.from]!
          const b = layout.nodes[e.to]!
          const x1 = a.x + NODE_W / 2
          const y1 = a.y + NODE_H
          const x2 = b.x + NODE_W / 2
          const y2 = b.y
          const my = (y1 + y2) / 2
          return <path key={`${e.from}>${e.to}`} className="dshws-dag-edge" d={`M${x1},${y1} C${x1},${my} ${x2},${my} ${x2},${y2}`} />
        })}
        {nodes.map((n) => {
          const p = layout.nodes[n.id]
          if (p === undefined) return null
          const isRoot = n.parentId === undefined
          const running = isRunning(n.id, live, list)
          const line = activityLine(t, live[n.id], running)
          const open = (): void => (isRoot ? props.onOpenMain(n) : props.onOpen(n))
          return (
            <g
              key={n.id}
              className="dshws-dag-node"
              data-running={running}
              data-root={isRoot}
              data-current={n.id === props.currentSessionId}
              transform={`translate(${p.x},${p.y})`}
              role="button"
              tabIndex={0}
              onClick={open}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  open()
                }
              }}
            >
              <title>{`${n.title}${line === '' ? '' : `\n${line}`}`}</title>
              <rect width={NODE_W} height={NODE_H} rx={8} />
              <circle className="dshws-dag-dot" cx={12} cy={15} r={4} />
              <text x={22} y={19} className="dshws-dag-title">{ellipsis(isRoot ? t('tasks.sub.root', { title: n.title }) : n.title, 19)}</text>
              <text x={10} y={35} className="dshws-dag-line">{ellipsis(line !== '' ? line : isRoot || n.mode === 'unknown' ? '' : t(`tasks.sub.mode.${n.mode}`), 23)}</text>
            </g>
          )
        })}
      </svg>
    </div>
  )
}
