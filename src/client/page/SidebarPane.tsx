/*
 * @Description: 「侧边栏」页签 —— 侧栏能力的管理中心：better-sidebar 状态、标签开关、文件关联、忽略规则、查看器、Agent / 任务、外观
 * @Author: YangHeng
 * @Date: 2026-10-10 14:00:00
 * @FilePath: /dsh-workspace/src/client/page/SidebarPane.tsx
 *
 * 偏好统一经 client/sidebar-prefs.ts 读写（乐观更新，开关即时生效）；
 * 「接管 DSH『文件』侧栏」与忽略规则沿用原有的独立偏好键（takeoverFilesSidebar / ignore），兼容已有设置。
 * 卡片样式与「全局配置」一致（dshws-set-card + SettingRow）；宿主 Switch 只把 label 当 aria-label，标题与说明自己画。
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Button, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import type { BetterSidebarStatus, BetterSidebarToggleOutput } from '../../wire/dto.js'
import { ASSOC_MODES, ASSOC_VIEWERS, LARGE_FILE_MB_MAX, LARGE_FILE_MB_MIN, mergeSidebarPrefs, normalizeExt, type AssocEntry, type AssocMode, type AssocViewer, type SidebarTabKey } from '../../wire/sidebar-prefs.js'
import { DEFAULT_ASSOCIATIONS } from '../viewers/defaults.js'
import { OPEN_WITH_MAX, OPEN_WITH_NAME_MAX, templateProblem, type OpenWithTemplate } from '../../wire/open-with.js'
import { getSidebarPrefs, saveSidebarPrefs, setSidebarPrefs, useSidebarPrefs, type SidebarPrefsPatch } from '../sidebar-prefs.js'
import { emitFilesTakeoverToggle, filesTakeover, type TakeoverStatus } from '../sidebar/files-takeover.js'
import { useNarrow } from '../narrow.js'
import { useDialogs } from './dialogs.js'
import { SettingRow } from './SettingsPane.js'
import type { useWorkspace } from './useWorkspace.js'

export interface SidebarPaneProps {
  t: Translate
  call: ReturnType<typeof useWorkspace>['call']
  notify(message: string): void
  onError(error: unknown): void
}

/** 标签开关的显示顺序（upcoming = 功能尚未上线、开关先行保存；目前已全部上线）。 */
const TAB_ROWS: ReadonlyArray<{ key: SidebarTabKey; upcoming?: boolean }> = [
  { key: 'files' },
  { key: 'git' },
  { key: 'viewer' },
  { key: 'ssh' },
  { key: 'tasks' },
  { key: 'sidechat' }
]

export function SidebarPane(props: SidebarPaneProps) {
  const { t } = props
  const prefs = useSidebarPrefs()
  const api = useMemo<WorkspaceApi>(() => ({ call: (method, payload) => props.call(method, payload) }), [props.call])
  const [filesOn, setFilesOn] = useState<boolean | null>(null)
  const [filesStatus, setFilesStatus] = useState<TakeoverStatus>(filesTakeover.status())
  const [ignore, setIgnore] = useState<{ rules: string[]; defaults: string[] } | null>(null)
  useEffect(() => filesTakeover.subscribe(() => setFilesStatus(filesTakeover.status())), [])

  useEffect(() => {
    // 进入页签时取一次最新值：别的窗口改过偏好时这里能看到。
    void props.call('getPrefs', {}).then((p) => {
      setFilesOn(p.takeoverFilesSidebar)
      setIgnore({ rules: p.ignore, defaults: p.defaultIgnore })
      setSidebarPrefs(p.sidebar)
    }, props.onError)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const save = (patch: SidebarPrefsPatch): void => {
    void saveSidebarPrefs(api, patch).catch(props.onError)
  }

  const changeFilesTakeover = (next: boolean): void => {
    setFilesOn(next)
    void props.call('setFilesTakeover', { enabled: next }).then(
      (p) => {
        setFilesOn(p.takeoverFilesSidebar)
        // 右侧栏即时接管 / 让出，不用刷新。
        emitFilesTakeoverToggle(p.takeoverFilesSidebar)
      },
      (error: unknown) => {
        setFilesOn(!next)
        props.onError(error)
      }
    )
  }

  const filesNote =
    filesOn !== true
      ? null
      : filesStatus.state === 'active'
        ? t('settings.filesTakeoverActive')
        : filesStatus.state === 'blocked'
          ? t(/better-sidebar/.test(filesStatus.holder) ? 'settings.filesTakeoverBetterSidebar' : 'settings.filesTakeoverBlocked', { holder: filesStatus.holder })
          : filesStatus.state === 'pending'
            ? t('settings.filesTakeoverPending')
            : null

  return (
    <div className="dshws-settings dshws-sbm">
      <BetterSidebarCard t={t} call={props.call} onError={props.onError} />

      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('sbm.tabs')}</div>
        {TAB_ROWS.map((row) => (
          <SettingRow
            key={row.key}
            title={t(`sbm.tab.${row.key}`)}
            desc={
              <>
                {t(`sbm.tab.${row.key}Hint`)}
                {row.upcoming === true ? <span className="dshws-set-note" data-tone="muted">{t('sbm.upcoming')}</span> : null}
              </>
            }
            control={<Switch checked={prefs.tabs[row.key]} label={t(`sbm.tab.${row.key}`)} onChange={(next) => save({ tabs: { [row.key]: next } })} />}
          />
        ))}
        <SettingRow
          title={t('sbm.remoteSshTerminal')}
          desc={t('sbm.remoteSshTerminalHint')}
          control={<Switch checked={prefs.remoteSshTerminal} label={t('sbm.remoteSshTerminal')} onChange={(next) => save({ remoteSshTerminal: next })} />}
        />
        <SettingRow
          title={t('sbm.tabEnhance')}
          desc={t('sbm.tabEnhanceHint')}
          control={<Switch checked={prefs.tabEnhance} label={t('sbm.tabEnhance')} onChange={(next) => save({ tabEnhance: next })} />}
        />
        <SettingRow
          title={t('settings.filesTakeover')}
          desc={
            <>
              {t('settings.filesTakeoverHint')}
              {filesNote !== null ? <span className="dshws-set-note" data-tone={filesStatus.state === 'active' ? 'ok' : 'warn'}>{filesNote}</span> : null}
            </>
          }
          disabled={filesOn === null}
          control={<Switch checked={filesOn === true} label={t('settings.filesTakeover')} disabled={filesOn === null} onChange={changeFilesTakeover} />}
        />
      </section>

      <AssociationsCard t={t} associations={prefs.associations} onSave={(next) => save({ associations: next })} />

      <IgnoreCard
        t={t}
        value={ignore}
        onSave={(rules) =>
          props.call('setIgnore', { rules }).then((p) => {
            setIgnore({ rules: p.ignore, defaults: p.defaultIgnore })
            props.notify(t('sbm.ignoreSaved'))
          }, props.onError)
        }
      />

      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('sbm.fileTree')}</div>
        <SettingRow
          title={t('sbm.autoRefresh')}
          desc={t('sbm.autoRefreshHint')}
          control={<Switch checked={prefs.autoRefresh} label={t('sbm.autoRefresh')} onChange={(next) => save({ autoRefresh: next })} />}
        />
        <OpenWithEditor t={t} value={prefs.openWith} onSave={(next) => save({ openWith: next })} />
      </section>

      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('sbm.viewerCard')}</div>
        <SettingRow
          title={t('sbm.largeFile')}
          desc={t('sbm.largeFileHint')}
          control={<LargeFileInput t={t} value={prefs.largeFileMB} onCommit={(mb) => save({ largeFileMB: mb })} />}
        />
        <SettingRow
          title={t('sbm.htmlNoSandbox')}
          desc={t('sbm.htmlNoSandboxHint')}
          control={<Switch checked={prefs.htmlNoSandbox} label={t('sbm.htmlNoSandbox')} onChange={(next) => save({ htmlNoSandbox: next })} />}
        />
      </section>

      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('sbm.agent')}</div>
        <SettingRow
          title={t('sbm.openInSidebar')}
          desc={t('sbm.openInSidebarHint')}
          control={<Switch checked={prefs.openInSidebar} label={t('sbm.openInSidebar')} onChange={(next) => save({ openInSidebar: next })} />}
        />
        <SettingRow
          title={t('sbm.tasksAutoOpen')}
          desc={t('sbm.tasksAutoOpenHint')}
          control={<Switch checked={prefs.tasksAutoOpen} label={t('sbm.tasksAutoOpen')} onChange={(next) => save({ tasksAutoOpen: next })} />}
        />
      </section>

      <section className="dshws-set-card">
        <div className="dshws-section-title">{t('sbm.appearance')}</div>
        <SettingRow
          title={t('sbm.imeGuard')}
          desc={t('sbm.imeGuardHint')}
          control={<Switch checked={prefs.imeGuard} label={t('sbm.imeGuard')} onChange={(next) => save({ imeGuard: next })} />}
        />
        <CustomCssEditor t={t} value={prefs.customCss} api={api} onError={props.onError} />
      </section>
    </div>
  )
}

// ---------------------------------------------------------------- better-sidebar

function BetterSidebarCard(props: { t: Translate; call: SidebarPaneProps['call']; onError(error: unknown): void }) {
  const { t } = props
  const dialogs = useDialogs()
  const [status, setStatus] = useState<BetterSidebarStatus | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BetterSidebarToggleOutput | null>(null)

  useEffect(() => {
    void props.call('betterSidebarStatus', {}).then(setStatus, () => setFailed(true))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (enabled: boolean): Promise<void> => {
    const ok = await dialogs.confirm({
      title: t(enabled ? 'sbm.bsEnableTitle' : 'sbm.bsDisableTitle'),
      message: (
        <ul className="dshws-sbm-impact">
          <li>{t('sbm.bsImpactProfile')}</li>
          <li>{t(enabled ? 'sbm.bsImpactEnable' : 'sbm.bsImpactReversible')}</li>
          <li>{t('sbm.bsImpactRefresh')}</li>
        </ul>
      ),
      confirmLabel: t(enabled ? 'sbm.bsEnable' : 'sbm.bsDisable'),
      danger: !enabled
    })
    if (!ok) return
    setBusy(true)
    try {
      const out = await props.call('betterSidebarSetEnabled', { enabled })
      setResult(out)
      setStatus(out.status)
    } catch (error) {
      props.onError(error)
    } finally {
      setBusy(false)
    }
  }

  let body: ReactNode
  if (status === null) {
    body = <div className="dshws-set-desc">{failed ? t('sbm.bsUnavailable') : t('sbm.bsChecking')}</div>
  } else if (!status.available) {
    body = <div className="dshws-set-desc">{t('sbm.bsUnavailable')}</div>
  } else if (!status.installed) {
    body = (
      <div className="dshws-set-desc">
        <span className="dshws-set-note" data-tone="ok">{t('sbm.bsNotInstalled')}</span>
      </div>
    )
  } else if (status.enabled) {
    body = (
      <div className="dshws-banner dshws-sbm-banner" data-tone="warn">
        <div className="dshws-banner-text">
          <div className="dshws-banner-title">{t('sbm.bsConflict')}</div>
          <div className="dshws-banner-hint">
            {t('sbm.bsConflictHint')}
            {status.readOnlyReason !== undefined ? <span className="dshws-set-note">{t('sbm.bsReadOnly', { reason: status.readOnlyReason })}</span> : null}
          </div>
        </div>
        <Button size="sm" variant="primary" className="dshws-danger-btn" disabled={busy || status.readOnlyReason !== undefined} onClick={() => void toggle(false)}>
          {t('sbm.bsDisable')}
        </Button>
      </div>
    )
  } else {
    body = (
      <SettingRow
        title={t('sbm.bsDisabled')}
        desc={
          <>
            {t('sbm.bsDisabledHint')}
            {status.readOnlyReason !== undefined ? <span className="dshws-set-note">{t('sbm.bsReadOnly', { reason: status.readOnlyReason })}</span> : null}
          </>
        }
        control={
          <Button size="sm" variant="outline" disabled={busy || status.readOnlyReason !== undefined} onClick={() => void toggle(true)}>
            {t('sbm.bsEnable')}
          </Button>
        }
      />
    )
  }

  return (
    <section className="dshws-set-card">
      <div className="dshws-section-title">{t('sbm.bs')}</div>
      {body}
      {result !== null ? <ToggleResult t={t} result={result} /> : null}
    </section>
  )
}

function ToggleResult(props: { t: Translate; result: BetterSidebarToggleOutput }) {
  const { t, result } = props
  const failed = result.application === 'failed' || result.application === 'cancelled'
  const text =
    result.application === 'applied'
      ? t('sbm.bsApplied')
      : result.application === 'restart-required'
        ? t('sbm.bsRestart')
        : result.application === 'overridden'
          ? t('sbm.bsOverridden')
          : t('sbm.bsFailed', { message: result.error ?? result.application })
  return (
    <div className="dshws-sbm-result" data-tone={failed ? 'error' : 'ok'}>
      <span>{text}</span>
      {failed ? null : (
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>
          {t('sbm.refresh')}
        </Button>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- 文件关联

function AssociationsCard(props: { t: Translate; associations: Record<string, AssocEntry> | null; onSave(next: Record<string, AssocEntry> | null): void }) {
  const { t } = props
  const narrow = useNarrow()
  const table = props.associations ?? (DEFAULT_ASSOCIATIONS as Record<string, AssocEntry>)
  const [filter, setFilter] = useState('')
  const [ext, setExt] = useState('')
  const [viewer, setViewer] = useState<AssocViewer>('monaco')
  const [mode, setMode] = useState<AssocMode | ''>('')
  const [error, setError] = useState<string | null>(null)

  const rows = useMemo(() => {
    const q = filter.trim().replace(/^\./, '').toLowerCase()
    return Object.entries(table)
      .filter(([e, a]) => q === '' || e.includes(q) || a.viewer.includes(q))
      .sort(([a], [b]) => a.localeCompare(b))
  }, [table, filter])

  const update = (next: Record<string, AssocEntry>): void => props.onSave(next)
  const entry = (v: AssocViewer, m: AssocMode | ''): AssocEntry => (m === '' ? { viewer: v } : { viewer: v, mode: m })

  const add = (): void => {
    const key = normalizeExt(ext)
    if (key === undefined) {
      setError(t('sbm.assocBadExt'))
      return
    }
    update({ ...table, [key]: entry(viewer, mode) })
    setExt('')
    setError(null)
  }

  return (
    <section className="dshws-set-card">
      <div className="dshws-sbm-cardhead">
        <div className="dshws-section-title">{t('sbm.assoc')}</div>
        <Button size="sm" variant="outline" disabled={props.associations === null} onClick={() => props.onSave(null)}>
          {t('sbm.restoreDefaults')}
        </Button>
      </div>
      <div className="dshws-set-desc">{t(props.associations === null ? 'sbm.assocHintDefault' : 'sbm.assocHintCustom')}</div>
      <div className="dshws-sbm-assoc-tools">
        <input className="dshws-input" value={filter} placeholder={t('sbm.assocFilter')} aria-label={t('sbm.assocFilter')} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="dshws-sbm-assoc" data-narrow={narrow}>
        {narrow ? null : (
          <div className="dshws-sbm-assoc-row dshws-sbm-assoc-head">
            <span>{t('sbm.assocExt')}</span>
            <span>{t('sbm.assocViewer')}</span>
            <span>{t('sbm.assocMode')}</span>
            <span />
          </div>
        )}
        {rows.map(([e, a]) => (
          <div key={e} className="dshws-sbm-assoc-row">
            <span className="dshws-sbm-ext">.{e}</span>
            <ViewerSelect t={t} value={a.viewer} onChange={(v) => update({ ...table, [e]: entry(v, a.mode ?? '') })} />
            <ModeSelect t={t} value={a.mode ?? ''} onChange={(m) => update({ ...table, [e]: entry(a.viewer, m) })} />
            <button
              type="button"
              className="dshws-icon-btn"
              data-danger="true"
              title={t('sbm.assocRemove')}
              aria-label={t('sbm.assocRemove')}
              onClick={() => {
                const next = { ...table }
                delete next[e]
                update(next)
              }}
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
                <path d="M4 4l8 8M12 4l-8 8" />
              </svg>
            </button>
          </div>
        ))}
        {rows.length === 0 ? <div className="dshws-set-desc dshws-sbm-empty">{t('sbm.assocEmpty')}</div> : null}
      </div>
      <div className="dshws-sbm-assoc-row dshws-sbm-assoc-add">
        <input
          className="dshws-input dshws-mono"
          value={ext}
          placeholder={t('sbm.assocExtPlaceholder')}
          aria-label={t('sbm.assocExt')}
          onChange={(e) => setExt(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <ViewerSelect t={t} value={viewer} onChange={setViewer} />
        <ModeSelect t={t} value={mode} onChange={setMode} />
        <Button size="sm" variant="outline" onClick={add}>
          {t('sbm.assocAdd')}
        </Button>
      </div>
      {error !== null ? <div className="dshws-field-error">{error}</div> : null}
    </section>
  )
}

function ViewerSelect(props: { t: Translate; value: AssocViewer; onChange(v: AssocViewer): void }) {
  return (
    <select className="dshws-select" value={props.value} aria-label={props.t('sbm.assocViewer')} onChange={(e) => props.onChange(e.target.value as AssocViewer)}>
      {ASSOC_VIEWERS.map((v) => (
        <option key={v} value={v}>
          {props.t(`sbm.viewer.${v}`)}
        </option>
      ))}
    </select>
  )
}

function ModeSelect(props: { t: Translate; value: AssocMode | ''; onChange(v: AssocMode | ''): void }) {
  return (
    <select className="dshws-select" value={props.value} aria-label={props.t('sbm.assocMode')} onChange={(e) => props.onChange(e.target.value as AssocMode | '')}>
      <option value="">{props.t('sbm.mode.auto')}</option>
      {ASSOC_MODES.map((m) => (
        <option key={m} value={m}>
          {props.t(`sbm.mode.${m}`)}
        </option>
      ))}
    </select>
  )
}

// ---------------------------------------------------------------- 忽略规则

function IgnoreCard(props: { t: Translate; value: { rules: string[]; defaults: string[] } | null; onSave(rules: string[]): Promise<void> }) {
  const { t } = props
  const [text, setText] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const shown = text ?? props.value?.rules.join('\n') ?? ''
  const dirty = text !== null && text !== (props.value?.rules.join('\n') ?? '')
  return (
    <section className="dshws-set-card">
      <div className="dshws-section-title">{t('sbm.ignore')}</div>
      <div className="dshws-set-desc">{t('sbm.ignoreHint')}</div>
      <textarea
        className="dshws-textarea dshws-mono dshws-sbm-textarea"
        rows={5}
        value={shown}
        placeholder={t('sbm.ignorePlaceholder')}
        aria-label={t('sbm.ignore')}
        disabled={props.value === null}
        spellCheck={false}
        onChange={(e) => setText(e.target.value)}
      />
      <div className="dshws-sbm-actions">
        <details className="dshws-sbm-defaults">
          <summary>{t('sbm.ignoreDefaults', { count: props.value?.defaults.length ?? 0 })}</summary>
          <code>{props.value?.defaults.join('  ') ?? ''}</code>
        </details>
        <Button
          size="sm"
          variant="primary"
          disabled={!dirty || saving}
          onClick={() => {
            setSaving(true)
            void props
              .onSave(shown.split(/\r?\n/))
              .then(() => setText(null))
              .finally(() => setSaving(false))
          }}
        >
          {t('sbm.save')}
        </Button>
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- 打开方式（自定义 URL 模板）

function OpenWithEditor(props: { t: Translate; value: readonly OpenWithTemplate[]; onSave(next: OpenWithTemplate[]): void }) {
  const { t } = props
  const [name, setName] = useState('')
  const [template, setTemplate] = useState('')
  const [error, setError] = useState<string | null>(null)
  const add = (): void => {
    const n = name.trim().slice(0, OPEN_WITH_NAME_MAX)
    const tpl = template.trim()
    if (props.value.length >= OPEN_WITH_MAX) {
      setError(t('sbm.openWithFull', { count: OPEN_WITH_MAX }))
      return
    }
    if (n === '' || templateProblem(tpl) !== undefined) {
      setError(t('sbm.openWithBad'))
      return
    }
    props.onSave([...props.value, { name: n, template: tpl }])
    setName('')
    setTemplate('')
    setError(null)
  }
  return (
    <div className="dshws-sbm-ow">
      <div className="dshws-set-title">{t('sbm.openWith')}</div>
      <div className="dshws-set-desc">{t('sbm.openWithHint')}</div>
      {props.value.length === 0 ? <div className="dshws-set-desc dshws-sbm-empty">{t('sbm.openWithEmpty')}</div> : null}
      {props.value.map((item, i) => (
        <div key={`${i}-${item.name}`} className="dshws-sbm-ow-row">
          <span className="dshws-sbm-ow-name">{item.name}</span>
          <code className="dshws-sbm-ow-tpl" title={item.template}>
            {item.template}
          </code>
          <button
            type="button"
            className="dshws-icon-btn"
            data-danger="true"
            title={t('sbm.openWithRemove')}
            aria-label={t('sbm.openWithRemove')}
            onClick={() => props.onSave(props.value.filter((_, j) => j !== i))}
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>
      ))}
      <div className="dshws-sbm-ow-row dshws-sbm-ow-add">
        <input className="dshws-input" value={name} placeholder={t('sbm.openWithName')} aria-label={t('sbm.openWithName')} maxLength={OPEN_WITH_NAME_MAX} onChange={(e) => setName(e.target.value)} />
        <input
          className="dshws-input dshws-mono"
          value={template}
          placeholder={t('sbm.openWithTemplatePlaceholder')}
          aria-label={t('sbm.openWithTemplate')}
          spellCheck={false}
          onChange={(e) => setTemplate(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
        <Button size="sm" variant="outline" onClick={add}>
          {t('sbm.openWithAdd')}
        </Button>
      </div>
      {error !== null ? <div className="dshws-field-error">{error}</div> : null}
    </div>
  )
}

// ---------------------------------------------------------------- 查看器 / 外观的输入控件

function LargeFileInput(props: { t: Translate; value: number; onCommit(mb: number): void }) {
  const [text, setText] = useState(String(props.value))
  useEffect(() => setText(String(props.value)), [props.value])
  const commit = (): void => {
    const n = Math.round(Number(text))
    if (!Number.isFinite(n) || n < LARGE_FILE_MB_MIN || n > LARGE_FILE_MB_MAX) {
      setText(String(props.value))
      return
    }
    if (n !== props.value) props.onCommit(n)
  }
  return (
    <label className="dshws-sbm-mb">
      <input
        className="dshws-input"
        type="number"
        min={LARGE_FILE_MB_MIN}
        max={LARGE_FILE_MB_MAX}
        value={text}
        aria-label={props.t('sbm.largeFile')}
        onChange={(e) => setText(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') commit()
        }}
      />
      <span>MB</span>
    </label>
  )
}

/** 自定义 CSS：边打边生效（只改页内缓存），停顿 600ms 后写宿主；离开页签时把没写完的那次补上。 */
function CustomCssEditor(props: { t: Translate; value: string; api: WorkspaceApi; onError(error: unknown): void }) {
  const { t } = props
  const [text, setText] = useState(props.value)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pending = useRef<string | null>(null)
  const flush = useRef<() => void>(() => undefined)
  flush.current = () => {
    if (timer.current !== undefined) clearTimeout(timer.current)
    timer.current = undefined
    const css = pending.current
    pending.current = null
    if (css !== null) void saveSidebarPrefs(props.api, { customCss: css }).catch(props.onError)
  }
  // 外部变化（宿主取回、别处修改）且本地没有未保存输入时同步过来。
  useEffect(() => {
    if (pending.current === null) setText(props.value)
  }, [props.value])
  useEffect(() => () => flush.current(), [])
  return (
    <div className="dshws-sbm-css">
      <div className="dshws-set-title">{t('sbm.customCss')}</div>
      <div className="dshws-set-desc">{t('sbm.customCssHint')}</div>
      <textarea
        className="dshws-textarea dshws-mono dshws-sbm-textarea"
        rows={6}
        value={text}
        placeholder={'/* .dshws-page { font-size: 14px; } */'}
        aria-label={t('sbm.customCss')}
        spellCheck={false}
        onChange={(e) => {
          const css = e.target.value
          setText(css)
          // 实时预览：只改页内缓存（appearance.ts 跟着更新 <style>），不立刻写宿主。
          setSidebarPrefs(mergeSidebarPrefs(getSidebarPrefs(), { customCss: css }))
          pending.current = css
          if (timer.current !== undefined) clearTimeout(timer.current)
          timer.current = setTimeout(() => flush.current(), 600)
        }}
      />
    </div>
  )
}
