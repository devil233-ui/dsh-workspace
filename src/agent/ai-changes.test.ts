/*
 * @Description: 「AI 改动」事件折叠的单测
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/agent/ai-changes.test.ts
 */
import { describe, expect, it } from 'vitest'
import { deletedPaths, extractAiOps, foldAiChanges, shellSegments } from './ai-changes.js'

let seq = 0
const call = (turn: number, callId: string, name: string, args: unknown) => ({
  seq: seq++,
  type: 'tool/call',
  data: { turn, step: 1, callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) }
})
const result = (callId: string, isError = false) => ({ seq: seq++, type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId }, isError, content: [] } } })
const turnStart = (turn: number) => ({ seq: seq++, type: 'turn/start', data: { turn } })
const resolve = (p: string): string | undefined => (p.startsWith('C:') ? undefined : p.startsWith('/') ? p : `/srv/app/${p}`)

describe('shellSegments / deletedPaths', () => {
  it('按 && ; | 换行分段，支持引号', () => {
    expect(shellSegments(`cd a && rm -f "x y.txt"; echo 'hi there' | cat`)).toEqual([['cd', 'a'], ['rm', '-f', 'x y.txt'], ['echo', 'hi there'], ['cat']])
  })

  it('rm / unlink / Remove-Item / del 识别删除的文件，跳过通配、变量与重定向目标', () => {
    expect(deletedPaths('rm -rf build/out.js src/old.ts')).toEqual(['build/out.js', 'src/old.ts'])
    expect(deletedPaths('sudo rm -- -weird.txt')).toEqual(['-weird.txt'])
    expect(deletedPaths('rm *.log $TMP/a ~/b.txt')).toEqual([])
    expect(deletedPaths('rm a.txt > /dev/null 2>&1')).toEqual(['a.txt'])
    // pwsh 里反斜杠是路径分隔符，不是转义。
    expect(deletedPaths('Remove-Item -LiteralPath C:\\x\\a.txt -Force', true)).toEqual(['C:\\x\\a.txt'])
    expect(deletedPaths("Remove-Item -Path 'a.txt','b.txt' -Recurse", true)).toEqual(['a.txt', 'b.txt'])
    expect(deletedPaths('Remove-Item a.txt,b.txt -Recurse', true)).toEqual(['a.txt', 'b.txt'])
    expect(deletedPaths('del /f /q old.txt', true)).toEqual(['old.txt'])
    expect(deletedPaths('rm a\\ b.txt')).toEqual(['a b.txt'])
    expect(deletedPaths('echo rm a.txt')).toEqual([])
  })
})

describe('extractAiOps', () => {
  it('写入 / 编辑 / str_replace_editor / 上传计入，读取不计，失败的剔除，未返回结果的保留', () => {
    seq = 0
    const events = [
      turnStart(1),
      call(1, 'a', 'write', { file_path: 'a.ts', content: 'x' }),
      result('a'),
      call(1, 'b', 'read', { file_path: 'a.ts' }),
      result('b'),
      call(1, 'c', 'edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y' }),
      result('c', true),
      call(1, 'd', 'str_replace_editor', { command: 'view', path: 'v.ts' }),
      call(1, 'e', 'str_replace_editor', { command: 'insert', path: 'e.ts', insert_line: 1, new_str: 'z' }),
      call(1, 'f', 'upload_to_remote', { attachment_id: 'sha256:x', target_path: 'img/a.png' })
    ]
    const { ops, turn } = extractAiOps(events)
    expect(turn).toBe(1)
    expect(ops.map((o) => [o.callId, o.kind, o.paths[0]])).toEqual([
      ['a', 'write', 'a.ts'],
      ['e', 'edit', 'e.ts'],
      ['f', 'write', 'img/a.png']
    ])
  })

  it('0.1.6 日志：错误标记在 tool-result 包装块上', () => {
    seq = 0
    const events = [
      call(1, 'a', 'write', { file_path: 'a.ts', content: 'x' }),
      { seq: seq++, type: 'tool/result', data: { message: { source: { callId: 'a' }, content: [{ type: 'tool-result', isError: true, content: [] }] } } }
    ]
    expect(extractAiOps(events).ops).toEqual([])
  })

  it('arguments 既可以是 JSON 字符串也可以是对象；坏 JSON 忽略', () => {
    seq = 0
    const events = [
      { seq: seq++, type: 'tool/call', data: { turn: 1, callId: 'a', name: 'write', arguments: { file_path: 'a.ts', content: '' } } },
      call(1, 'b', 'write', '{bad json')
    ]
    expect(extractAiOps(events).ops.map((o) => o.callId)).toEqual(['a'])
  })
})

describe('foldAiChanges', () => {
  it('按文件聚合操作次数，区分本轮；本轮 = 最近一个轮次；工作区外的路径不计', () => {
    seq = 0
    const events = [
      turnStart(1),
      call(1, 'a', 'write', { file_path: 'a.ts', content: 'x' }),
      call(1, 'b', 'edit', { file_path: '/srv/app/a.ts', old_string: 'x', new_string: 'y' }),
      call(1, 'c', 'write', { file_path: 'C:\\local.txt', content: 'x' }),
      turnStart(2),
      call(2, 'd', 'edit', { file_path: 'a.ts', old_string: 'y', new_string: 'z' }),
      call(2, 'e', 'bash', { command: 'rm old.ts', description: 'rm' })
    ]
    const r = foldAiChanges(events, resolve)
    expect(r.turn).toBe(2)
    expect(r.files).toEqual([
      { path: '/srv/app/old.ts', ops: 1, turnOps: 1, last: 'delete', lastSeq: 6 },
      { path: '/srv/app/a.ts', ops: 3, turnOps: 1, last: 'edit', lastSeq: 5 }
    ])
  })

  it('新轮次刚开始、还没改文件时本轮为空', () => {
    seq = 0
    const events = [turnStart(1), call(1, 'a', 'write', { file_path: 'a.ts', content: 'x' }), turnStart(2)]
    const r = foldAiChanges(events, resolve)
    expect(r.turn).toBe(2)
    expect(r.files[0]).toMatchObject({ ops: 1, turnOps: 0 })
  })

  it('远程会话不计本机 shell 的删除（主机保留本机 shell 时它删的是本机文件）；本机会话照常计入', () => {
    seq = 0
    const events = [
      turnStart(1),
      call(1, 'a', 'pwsh', { command: 'Remove-Item foo.txt' }),
      call(1, 'b', 'cmd', { command: 'del /q bar.txt' }),
      call(1, 'c', 'bash', { command: 'rm baz.txt', description: 'rm' })
    ]
    expect(foldAiChanges(events, resolve, { remote: true }).files.map((f) => f.path)).toEqual(['/srv/app/baz.txt'])
    expect(foldAiChanges(events, resolve).files.map((f) => f.path)).toContain('/srv/app/foo.txt')
  })
})
