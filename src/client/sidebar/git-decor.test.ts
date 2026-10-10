/*
 * @Description: 文件树 Git 装饰的测试 —— 状态 → 字母映射、父目录着色优先级、根路径拼接
 * @Author: YangHeng
 * @Date: 2026-10-10 15:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/git-decor.test.ts
 */
import { describe, expect, it } from 'vitest'
import { NO_DECORATIONS, buildDecorations, markOf, sameDecorations } from './git-decor.js'

const f = (path: string, index: string, worktree: string, kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' = 'changed') => ({ path, index, worktree, kind })

describe('markOf', () => {
  it('工作区优先，其次暂存区；未跟踪 ??、冲突 U', () => {
    expect(markOf(f('a', 'M', '.'))).toBe('M')
    expect(markOf(f('a', 'A', '.'))).toBe('A')
    expect(markOf(f('a', 'A', 'M'))).toBe('M')
    expect(markOf(f('a', '.', 'D'))).toBe('D')
    expect(markOf(f('a', 'D', '.'))).toBe('D')
    expect(markOf(f('a', 'R', '.', 'renamed'))).toBe('R')
    expect(markOf(f('a', 'C', '.'))).toBe('A')
    expect(markOf(f('a', '.', 'T'))).toBe('M')
    expect(markOf(f('a', '?', '?', 'untracked'))).toBe('??')
    expect(markOf(f('a', 'U', 'U', 'unmerged'))).toBe('U')
    expect(markOf(f('a', '.', '.'))).toBeUndefined()
  })
})

describe('buildDecorations', () => {
  it('文件按绝对路径记徽标；父目录逐级着色，取最严重（冲突 > 修改 > 删除 > 新增 > 未跟踪）', () => {
    const d = buildDecorations('/home/ps/w', [
      f('src/a.ts', 'M', '.'),
      f('src/new.ts', '?', '?', 'untracked'),
      f('src/lib/gone.ts', '.', 'D'),
      f('docs/x.md', 'A', '.'),
      f('docs/y.md', '?', '?', 'untracked'),
      f('top.txt', 'U', 'U', 'unmerged')
    ])
    expect(d.files.get('/home/ps/w/src/a.ts')).toBe('M')
    expect(d.files.get('/home/ps/w/src/new.ts')).toBe('??')
    expect(d.files.get('/home/ps/w/top.txt')).toBe('U')
    expect(d.dirs.get('/home/ps/w/src')).toBe('M')
    expect(d.dirs.get('/home/ps/w/src/lib')).toBe('D')
    expect(d.dirs.get('/home/ps/w/docs')).toBe('A')
    expect(d.dirs.has('/home/ps/w')).toBe(false)
  })

  it('根为 / 或本地 POSIX 盘符路径时拼接正确；结尾斜杠的目录项按目录处理', () => {
    expect(buildDecorations('/', [f('etc/x', 'M', '.')]).files.get('/etc/x')).toBe('M')
    const w = buildDecorations('/C:/proj/', [f('a\\b.ts', '.', 'M'), f('newdir/', '?', '?', 'untracked')])
    expect(w.files.get('/C:/proj/a/b.ts')).toBe('M')
    expect(w.dirs.get('/C:/proj/newdir')).toBe('??')
  })

  it('sameDecorations', () => {
    const a = buildDecorations('/w', [f('a', 'M', '.')])
    const b = buildDecorations('/w', [f('a', 'M', '.')])
    expect(sameDecorations(a, b)).toBe(true)
    expect(sameDecorations(a, NO_DECORATIONS)).toBe(false)
    expect(sameDecorations(a, buildDecorations('/w', [f('a', '.', 'D')]))).toBe(false)
  })
})
