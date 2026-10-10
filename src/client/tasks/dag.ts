/*
 * @Description: 拓扑图的分层 DAG 布局（自绘 SVG 用；不引入图布局库）
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/dag.ts
 *
 * 简化版 Sugiyama：
 * 1. 去环：按输入顺序 DFS，回边丢弃（子代理目录本是树，防御异常数据）；
 * 2. 分层：最长路径（节点层 = 所有父节点层 + 1 的最大值），从上到下；
 * 3. 层内排序：第 0 层按输入顺序，之后每层按父节点位置的重心（平均序号）排，同重心保持输入顺序；
 * 4. 坐标：每层水平居中，层间等距。
 * 节点数是几十到几百的量级，O(V+E) 加一次排序足够。
 */

export interface DagOptions {
  nodeWidth: number
  nodeHeight: number
  gapX: number
  gapY: number
  padding: number
}

export const DEFAULT_DAG_OPTIONS: DagOptions = { nodeWidth: 168, nodeHeight: 44, gapX: 16, gapY: 36, padding: 12 }

export interface DagNodePos {
  x: number
  y: number
  layer: number
  /** 层内序号。 */
  order: number
}

export interface DagLayout {
  nodes: Record<string, DagNodePos>
  /** 保留下来的边（去掉回边、自环、悬空边）。 */
  edges: Array<{ from: string; to: string }>
  layers: string[][]
  width: number
  height: number
}

export function layoutDag(nodeIds: readonly string[], edgeList: ReadonlyArray<{ from: string; to: string }>, options: Partial<DagOptions> = {}): DagLayout {
  const o = { ...DEFAULT_DAG_OPTIONS, ...options }
  const ids = [...new Set(nodeIds)]
  const index = new Map(ids.map((id, i) => [id, i]))
  const out = new Map<string, string[]>(ids.map((id) => [id, []]))
  const seenEdge = new Set<string>()
  for (const e of edgeList) {
    if (!index.has(e.from) || !index.has(e.to) || e.from === e.to) continue
    const key = `${e.from}\u0000${e.to}`
    if (seenEdge.has(key)) continue
    seenEdge.add(key)
    out.get(e.from)!.push(e.to)
  }

  // 1. 去环：DFS 中指向「正在访问」节点的边是回边。用显式栈，避免深链爆栈。
  const state = new Map<string, 0 | 1 | 2>()
  const edges: Array<{ from: string; to: string }> = []
  for (const start of ids) {
    if (state.get(start) === 2) continue
    const stack: Array<{ id: string; next: number }> = [{ id: start, next: 0 }]
    state.set(start, 1)
    while (stack.length > 0) {
      const top = stack[stack.length - 1]!
      const targets = out.get(top.id)!
      if (top.next >= targets.length) {
        state.set(top.id, 2)
        stack.pop()
        continue
      }
      const to = targets[top.next++]!
      const s = state.get(to) ?? 0
      if (s === 1) continue
      edges.push({ from: top.id, to })
      if (s === 0) {
        state.set(to, 1)
        stack.push({ id: to, next: 0 })
      }
    }
  }

  // 2. 分层：拓扑序（Kahn）上取最长路径。
  const parents = new Map<string, string[]>(ids.map((id) => [id, []]))
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]))
  const children = new Map<string, string[]>(ids.map((id) => [id, []]))
  for (const e of edges) {
    parents.get(e.to)!.push(e.from)
    children.get(e.from)!.push(e.to)
    indeg.set(e.to, indeg.get(e.to)! + 1)
  }
  const layer = new Map<string, number>(ids.map((id) => [id, 0]))
  const queue = ids.filter((id) => indeg.get(id) === 0)
  for (let i = 0; i < queue.length; i += 1) {
    const id = queue[i]!
    for (const c of children.get(id)!) {
      layer.set(c, Math.max(layer.get(c)!, layer.get(id)! + 1))
      const d = indeg.get(c)! - 1
      indeg.set(c, d)
      if (d === 0) queue.push(c)
    }
  }
  const layerCount = ids.length === 0 ? 0 : Math.max(...ids.map((id) => layer.get(id)!)) + 1
  const layers: string[][] = Array.from({ length: layerCount }, () => [])
  for (const id of ids) layers[layer.get(id)!]!.push(id)

  // 3. 层内排序：父节点重心。
  const order = new Map<string, number>()
  layers.forEach((row, l) => {
    if (l > 0) {
      const center = (id: string): number => {
        const ps = parents.get(id)!
        return ps.length === 0 ? Number.POSITIVE_INFINITY : ps.reduce((sum, p) => sum + order.get(p)!, 0) / ps.length
      }
      row.sort((a, b) => center(a) - center(b) || index.get(a)! - index.get(b)!)
    }
    row.forEach((id, i) => order.set(id, i))
  })

  // 4. 坐标。
  const widest = Math.max(0, ...layers.map((row) => row.length))
  const span = (n: number): number => (n === 0 ? 0 : n * o.nodeWidth + (n - 1) * o.gapX)
  const width = span(widest) + o.padding * 2
  const height = (layerCount === 0 ? 0 : layerCount * o.nodeHeight + (layerCount - 1) * o.gapY) + o.padding * 2
  const nodes: Record<string, DagNodePos> = {}
  layers.forEach((row, l) => {
    const offset = o.padding + (span(widest) - span(row.length)) / 2
    row.forEach((id, i) => {
      nodes[id] = { x: offset + i * (o.nodeWidth + o.gapX), y: o.padding + l * (o.nodeHeight + o.gapY), layer: l, order: i }
    })
  })
  return { nodes, edges, layers, width, height }
}
