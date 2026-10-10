/*
 * @Description: 文件树的 Git 状态装饰 —— git status 结果 → 每个文件的字母徽标 + 含改动目录的着色
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/git-decor.ts
 *
 * 徽标字母（与 git status --short 的习惯一致）：
 *   M 修改 / A 新增（含复制）/ D 删除 / R 重命名 / U 冲突（未合并）/ ?? 未跟踪
 * 同一文件暂存区与工作区都有变化时取工作区（磁盘上看到的就是它）；工作区无变化再看暂存区。
 * 目录不显示字母，只按其下最「严重」的改动着色：冲突 > 修改 > 删除 > 新增 / 重命名 > 未跟踪。
 * 已删除的文件不在树里，只体现在父目录颜色上。
 * 路径：git status 给的是相对仓库根的路径，这里按「仓库根 = 工作区根」拼接（工作区是仓库子目录时装饰对不上，见风险说明）。
 */
import type { GitFileStatus } from '../../git/parse.js'

export type GitMark = 'M' | 'A' | 'D' | 'R' | 'U' | '??'

/** 着色的严重程度（目录取子项最大值）。 */
const RANK: Record<GitMark, number> = { U: 6, M: 5, D: 4, A: 3, R: 3, '??': 2 }

export interface GitDecorations {
  /** 文件绝对路径 → 徽标。 */
  files: ReadonlyMap<string, GitMark>
  /** 目录绝对路径 → 着色（其下最严重的改动）。 */
  dirs: ReadonlyMap<string, GitMark>
}

export const NO_DECORATIONS: GitDecorations = { files: new Map(), dirs: new Map() }

/** 单个文件的徽标；没有可显示的变化返回 undefined。 */
export function markOf(f: Pick<GitFileStatus, 'index' | 'worktree' | 'kind'>): GitMark | undefined {
  if (f.kind === 'untracked') return '??'
  if (f.kind === 'unmerged') return 'U'
  const pick = (c: string): GitMark | undefined => {
    if (c === 'M' || c === 'T') return 'M'
    if (c === 'A' || c === 'C') return 'A'
    if (c === 'D') return 'D'
    if (c === 'R') return 'R'
    if (c === 'U') return 'U'
    return undefined
  }
  return pick(f.worktree) ?? pick(f.index)
}

/** git status → 装饰表。root 为工作区根的绝对路径（远程 POSIX / 本地 POSIX 形式）。 */
export function buildDecorations(root: string, files: readonly Pick<GitFileStatus, 'path' | 'index' | 'worktree' | 'kind'>[]): GitDecorations {
  const base = root.length > 1 ? root.replace(/\/+$/, '') : root
  const join = (rel: string): string => (base === '/' ? `/${rel}` : `${base}/${rel}`)
  const fileMap = new Map<string, GitMark>()
  const dirMap = new Map<string, GitMark>()
  for (const f of files) {
    const mark = markOf(f)
    if (mark === undefined) continue
    // 未跟踪的整个目录在 --untracked-files=all 下会逐个列出文件；个别 git 版本给出以 / 结尾的目录，按目录处理。
    const rel = f.path.replace(/\\/g, '/').replace(/\/+$/, '')
    if (rel === '') continue
    const abs = join(rel)
    if (f.path.endsWith('/')) dirMap.set(abs, stronger(dirMap.get(abs), mark))
    else fileMap.set(abs, mark)
    // 逐级给父目录着色（不含工作区根本身）。
    const parts = rel.split('/')
    for (let i = parts.length - 1; i > 0; i -= 1) {
      const dir = join(parts.slice(0, i).join('/'))
      dirMap.set(dir, stronger(dirMap.get(dir), mark))
    }
  }
  return { files: fileMap, dirs: dirMap }
}

function stronger(a: GitMark | undefined, b: GitMark): GitMark {
  return a === undefined || RANK[b] > RANK[a] ? b : a
}

/** 两份装饰是否相同（轮询结果没变时不触发重渲染）。 */
export function sameDecorations(a: GitDecorations, b: GitDecorations): boolean {
  const eq = (x: ReadonlyMap<string, GitMark>, y: ReadonlyMap<string, GitMark>): boolean => {
    if (x.size !== y.size) return false
    for (const [k, v] of x) if (y.get(k) !== v) return false
    return true
  }
  return eq(a.files, b.files) && eq(a.dirs, b.dirs)
}
