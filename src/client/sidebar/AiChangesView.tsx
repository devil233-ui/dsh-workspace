/*
 * @Description: Git 侧栏「AI 改动」页签 —— 本轮 / 全部会话里模型写入、编辑、删除过的文件
 * @Author: YangHeng
 * @Date: 2026-10-10 12:00:00
 * @FilePath: /dsh-workspace/src/client/sidebar/AiChangesView.tsx
 *
 * 只负责列表展示；点开文件后的 diff / 打开文件由 GitTab 决定（仓库内对比、仓库外直接打开）。
 */
import { ROW_HEIGHT, VirtualList } from './VirtualList.js'
import { FileIcon, StatusBadge } from './ui.js'
import { rowButtonProps } from './row-activate.js'
import { displayPath } from './remote-index.js'
import { filesInScope, repoRelative, type AiChangesState, type AiScope } from './ai-changes.js'
import type { SidebarBodyProps } from './RemoteFileTab.js'
import type { AiChangedFile } from '../../wire/ai-changes.js'

/** 操作类型 → 徽标字母（W 写入 / E 编辑 / D 删除，颜色见 styles.ts 的 .dshws-st）。 */
const LETTER = { write: 'W', edit: 'E', delete: 'D' } as const

export interface AiChangesViewProps {
  t: SidebarBodyProps['t']
  state: AiChangesState
  scope: AiScope
  onScope(scope: AiScope): void
  /** 工作区根（列表里显示相对路径用）。 */
  rootDir: string
  /** 右侧当前打开的文件（高亮）。 */
  selected: string | null
  onOpen(file: AiChangedFile): void
}

export function AiChangesView(props: AiChangesViewProps) {
  const { t, state, scope } = props
  const data = state.data
  const turnFiles = filesInScope(data, 'turn')
  const files = scope === 'turn' ? turnFiles : filesInScope(data, 'all')

  const row = (f: AiChangedFile) => {
    const rel = repoRelative(props.rootDir, f.path)
    const shown = rel ?? displayPath(f.path)
    const name = shown.slice(Math.max(shown.lastIndexOf('/'), shown.lastIndexOf('\\')) + 1)
    const dir = shown.length > name.length ? shown.slice(0, shown.length - name.length - 1) : ''
    const count = scope === 'turn' ? f.turnOps : f.ops
    return (
      <div className="dshws-git-row" data-selected={props.selected === f.path} {...rowButtonProps(() => props.onOpen(f))}>
        <span className="dshws-git-file" title={`${displayPath(f.path)}\n${t(`git.ai.kind.${f.last}`)} · ${t('git.ai.ops', { count })}`}>
          <StatusBadge s={LETTER[f.last]} />
          <FileIcon name={name} />
          <span className="dshws-side-name" data-deleted={f.last === 'delete'}>{name}</span>
          {dir !== '' ? <span className="dshws-git-dir">{dir}</span> : null}
          <span className="dshws-ai-ops" aria-label={t('git.ai.ops', { count })}>×{count}</span>
        </span>
      </div>
    )
  }

  const header = (
    <>
      <div className="dshws-ai-head">
        <span className="dshws-side-seg" role="radiogroup">
          <button type="button" role="radio" aria-checked={scope === 'turn'} data-active={scope === 'turn'} onClick={() => props.onScope('turn')}>
            {t('git.ai.turn')} ({turnFiles.length})
          </button>
          <button type="button" role="radio" aria-checked={scope === 'all'} data-active={scope === 'all'} onClick={() => props.onScope('all')}>
            {t('git.ai.all')} ({data?.files.length ?? 0})
          </button>
        </span>
      </div>
      <div className="dshws-ai-hint">{t('git.ai.hint')}</div>
      {state.error !== null ? <div className="dshws-tree-note" data-tone="error">{state.error}</div> : null}
      {data === null ? (
        state.error === null ? <div className="dshws-tree-note">{t('files.loading')}</div> : null
      ) : !data.available ? (
        <div className="dshws-side-note">{t('git.ai.unavailable')}</div>
      ) : files.length === 0 ? (
        <div className="dshws-side-note">{scope === 'turn' ? t('git.ai.emptyTurn') : t('git.ai.emptyAll')}</div>
      ) : null}
    </>
  )

  return <VirtualList items={files} itemKey={(f) => f.path} itemHeight={() => ROW_HEIGHT} renderItem={row} header={header} />
}
