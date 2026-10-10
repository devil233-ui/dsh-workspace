/*
 * @Description: 侧边对话（方案 3.8）界面 —— 右侧栏标签正文（线程列表 / 嵌入宿主会话视图）、嵌入的会话插槽、会话页头按钮
 * @Author: YangHeng
 * @Date: 2026-10-10 20:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/SidechatTab.tsx
 *
 * 嵌入方式照搬宿主子代理查看器（dsh-client-ui-subagent 的 SidebarChatTab / ConversationSlotPanel）：
 * 资源提供方 retain 会话 → 标签正文用 useResource 取到 SessionReference → SessionProvider 包住自声明的
 * 子插槽 dshws.sidechat.conversation → 子插槽里 renderFactorySlot('conversation.content', { variant: 'embedded' })，
 * views 固定为「对话」视图。输入框、消息流、停止 / 排队全部是宿主原生组件。
 * 同一个标签类型两种用法：页面地址（sidebar://dshws-sidechat/...，从引导列表打开）显示当前会话的线程列表；
 * 资源地址（dsh-resource://dshws-sidechat/session/<id>）显示嵌入的会话。
 */
import { useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react'
import type { Translate } from '../context.js'
import type { SidebarTabInfo } from '../sidebar/RemoteFileTab.js'
import { IconSideChat } from '../sidebar/ui.js'
import { useSessionList } from '../tasks/hooks.js'
import type { SessionListSnapshot } from '../tasks/host.js'
import { useSidebarPrefs } from '../sidebar-prefs.js'
import { sidechatThreads, type SidechatRecord } from '../../wire/sidebar-prefs.js'
import { parseSidechatAddress, type SidechatAddress } from './address.js'
import { forkBlocked, forkErrorText, forkPending, isForkUnavailable } from './fork-pending.js'
import { isSessionActiveRefusal, type SessionReferenceLike, type SidechatHost } from './host.js'
import { askConfirm } from '../sidebar/ContextMenu.js'

/** 自声明的子插槽名（不能复用宿主的 sidebar.chat.conversation：同名插槽只能被声明一次）。 */
export const SIDECHAT_CONVERSATION_SLOT = 'dshws.sidechat.conversation'

/** 侧边对话的操作（由 register.ts 实现：分叉 + 记录 + 打开；移除记录；删除）。 */
export interface SidechatActions {
  /** 从 parentId 新建侧边对话并在侧栏打开；失败抛错（调用方显示）。 */
  start(parentId: string): Promise<void>
  /** 只移除插件记录（会话已不存在时用）。 */
  remove(childId: string): Promise<void>
  /** 从左侧工作区移除该会话（宿主归档）→ 关闭打开着的标签 → 移除记录；宿主失败时抛错且不动记录。 */
  delete(childId: string, options?: { stopActivity?: boolean }): Promise<void>
}

/**
 * 删除流程：先确认（破坏性操作）；宿主因「会话仍在运行」拒绝时，与左侧会话列表一样再问一次是否停止后删除。
 * 返回 cancelled = 用户取消（任何一步）；其他失败原样抛出，由界面显示错误。
 */
export async function confirmAndDelete(
  childId: string,
  deps: { confirm(step: 'delete' | 'stop'): Promise<boolean>; del(childId: string, options?: { stopActivity?: boolean }): Promise<void> }
): Promise<'deleted' | 'cancelled'> {
  if (!(await deps.confirm('delete'))) return 'cancelled'
  try {
    await deps.del(childId)
  } catch (error) {
    if (!isSessionActiveRefusal(error)) throw error
    if (!(await deps.confirm('stop'))) return 'cancelled'
    await deps.del(childId, { stopActivity: true })
  }
  return 'deleted'
}

export interface SidechatInjected {
  t: Translate
  host: SidechatHost
  actions: SidechatActions
  sessionId: string
}

interface ResourceSnapshot {
  status?: string
  value?: { address: SidechatAddress; reference: SessionReferenceLike }
  failure?: unknown
}

export interface SidechatTabProps extends SidechatInjected {
  useTabInfo(): SidebarTabInfo
  useResource?(address: string): ResourceSnapshot
  SessionProvider?: ComponentType<{ session: SessionReferenceLike; children?: ReactNode }>
  renderSlot?(name: string, props: object): ReactNode
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 订阅「暂无已完成轮次」的会话集合（线程页与页头按钮共用）。 */
function useForkPending(): ReadonlySet<string> {
  return useSyncExternalStore(forkPending.subscribe, forkPending.getSnapshot, forkPending.getSnapshot)
}

/**
 * 分叉失败的统一处理：fork-unavailable 且会话仍在运行 → 记住并清空错误（改由「等待本轮结束」提示接管，
 * running 结束自动恢复）；否则返回要显示的文案（fork-unavailable 给友好文案，其他错误原样）。
 */
function handleForkError(err: unknown, sessionId: string, list: Parameters<typeof forkPending.mark>[1], t: Translate): string | null {
  if (isForkUnavailable(err) && forkPending.mark(sessionId, list)) return null
  return forkErrorText(err, t)
}

/** 右侧栏标签正文：按地址分派到「线程列表」或「嵌入会话」。 */
export function SidechatTab(props: SidechatTabProps) {
  const { tab } = props.useTabInfo()
  const address = parseSidechatAddress(tab.contentId)
  if (address === undefined) return <SidechatThreads {...props} />
  return <SidechatEmbed {...props} contentId={tab.contentId} address={address} />
}

/** 会话 id → 它所属的「侧边对话父会话」：本身是侧边对话时列它兄弟线程，否则列它自己的线程。 */
export function threadParentOf(records: readonly SidechatRecord[], sessionId: string): string {
  return records.find((r) => r.childId === sessionId)?.parentId ?? sessionId
}

/** 列表加载完之前不判「已删除」（返回 undefined = 未知，保留记录）。 */
export function existsIn(list: SessionListSnapshot): (id: string) => boolean | undefined {
  return (id) => (list.phase === 'ready' ? list.byId[id] !== undefined : list.byId[id] !== undefined ? true : undefined)
}

function SidechatThreads(props: SidechatTabProps) {
  const { t, host, actions, sessionId } = props
  const prefs = useSidebarPrefs()
  const store = host.sessionList()
  const list = useSessionList(store)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const parentId = threadParentOf(prefs.sidechats, sessionId)
  const threads = sidechatThreads(prefs.sidechats, parentId, existsIn(list))
  const available = host.available()
  const parentBlank = list.byId[parentId]?.blank === true
  // 为什么不能只看 blank：宿主在第一轮开始时就把 blank 置 false，但此时还没有已完成轮次可分叉。
  const parentWaiting = forkBlocked(useForkPending(), list.byId[parentId])

  const start = (): void => {
    setBusy(true)
    setError(null)
    actions.start(parentId).then(
      () => setBusy(false),
      (err: unknown) => {
        setBusy(false)
        setError(handleForkError(err, parentId, store, t))
      }
    )
  }
  const fail = (): void => setError(t('sidechat.openFailed'))
  const [deleting, setDeleting] = useState<string | null>(null)
  const remove = (childId: string, title: string): void => {
    setError(null)
    setDeleting(childId)
    confirmAndDelete(childId, {
      confirm: (step) =>
        askConfirm({
          message: step === 'delete' ? t('sidechat.deleteConfirm', { title }) : t('sidechat.deleteRunning', { title }),
          okLabel: step === 'delete' ? t('sidechat.delete') : t('sidechat.stopAndDelete'),
          cancelLabel: t('form.cancel'),
          danger: true
        }),
      del: (id, options) => actions.delete(id, options)
    })
      .catch((err: unknown) => setError(t('sidechat.deleteFailed', { message: messageOf(err) })))
      .finally(() => setDeleting(null))
  }

  return (
    <div className="dshws-side dshws-sidechat-list">
      <div className="dshws-sidechat-list-head">
        <div className="dshws-sidechat-list-title">{t('sidechat.threads')}</div>
        <button type="button" className="dshws-tasks-btn" disabled={!available || busy || parentBlank || parentWaiting} onClick={start} title={parentBlank ? t('sidechat.blankHint') : parentWaiting ? t('sidechat.waitTurn') : undefined}>
          {busy ? t('sidechat.creating') : t('sidechat.new')}
        </button>
      </div>
      <div className="dshws-sidechat-hint">{t('sidechat.listHint')}</div>
      {!available ? <div className="dshws-tasks-note" data-tone="warn">{t('sidechat.unsupported')}</div> : null}
      {parentWaiting ? <div className="dshws-tasks-note">{t('sidechat.waitTurn')}</div> : null}
      {error !== null ? <div className="dshws-tasks-note" data-tone="error">{error}</div> : null}
      {threads.length === 0 ? (
        <div className="dshws-tasks-empty">{t('sidechat.empty')}</div>
      ) : (
        <div className="dshws-sidechat-rows">
          {threads.map((r) => {
            const s = list.byId[r.childId]
            return (
              <div key={r.childId} className="dshws-sidechat-row">
                <div className="dshws-sidechat-row-main">
                  {s?.running === true ? <span className="dshws-dot" data-state="running" /> : null}
                  <span className="dshws-sidechat-row-title" title={s?.displayTitle ?? r.childId}>{s?.displayTitle ?? r.childId}</span>
                  <span className="dshws-sidechat-row-time">{new Date(r.createdAt).toLocaleString()}</span>
                </div>
                <div className="dshws-sidechat-row-actions">
                  <button type="button" className="dshws-link-btn" onClick={() => host.openAside(r.childId, r.parentId) || fail()}>
                    {t('sidechat.openAside')}
                  </button>
                  <button type="button" className="dshws-link-btn" onClick={() => host.openMain(r.childId) || fail()}>
                    {t('sidechat.openMain')}
                  </button>
                  <button type="button" className="dshws-link-btn" data-tone="danger" disabled={deleting !== null} onClick={() => remove(r.childId, s?.displayTitle ?? r.childId)}>
                    {deleting === r.childId ? t('sidechat.deleting') : t('sidechat.delete')}
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function SidechatEmbed(props: SidechatTabProps & { contentId: string; address: SidechatAddress }) {
  const { t, host, address } = props
  // useResource / SessionProvider / renderSlot 由插槽框架注入（注册时声明了会话作用域子插槽）；旧宿主没有就降级提示。
  if (props.useResource === undefined || props.SessionProvider === undefined || props.renderSlot === undefined) {
    return <div className="dshws-side-note">{t('sidechat.unsupported')}</div>
  }
  return <SidechatEmbedBody {...props} useResource={props.useResource} SessionProvider={props.SessionProvider} renderSlot={props.renderSlot} host={host} address={address} />
}

function SidechatEmbedBody(
  props: SidechatTabProps & {
    contentId: string
    address: SidechatAddress
    useResource(address: string): ResourceSnapshot
    SessionProvider: ComponentType<{ session: SessionReferenceLike; children?: ReactNode }>
    renderSlot(name: string, props: object): ReactNode
  }
) {
  const { t, host, actions, address, SessionProvider } = props
  const resource = props.useResource(props.contentId)
  const [hint, setHint] = useState(true)
  const failed = resource.status === 'failed' || resource.status === 'none'
  return (
    <div className="dshws-sidechat" data-sidechat="">
      <div className="dshws-sidechat-bar">
        <IconSideChat />
        <span className="dshws-sidechat-bar-text" title={t('sidechat.boundaryHint')}>
          {hint ? t('sidechat.boundaryHint') : t('sidechat.label')}
        </span>
        <button type="button" className="dshws-link-btn" onClick={() => host.openMain(address.childId)}>
          {t('sidechat.openMain')}
        </button>
        {hint ? (
          <button type="button" className="dshws-link-btn" data-tone="muted" onClick={() => setHint(false)} aria-label={t('sidechat.hideHint')}>
            ×
          </button>
        ) : null}
      </div>
      <div className="dshws-sidechat-body">
        {resource.value !== undefined ? (
          <SessionProvider session={resource.value.reference}>{props.renderSlot(SIDECHAT_CONVERSATION_SLOT, {})}</SessionProvider>
        ) : failed ? (
          <div className="dshws-side-note" data-tone="error">
            {t('sidechat.gone')}
            <button type="button" className="dshws-link-btn" onClick={() => void actions.remove(address.childId).catch(() => undefined)}>
              {t('sidechat.remove')}
            </button>
          </div>
        ) : (
          <div className="dshws-side-note">{t('files.loading')}</div>
        )}
      </div>
    </div>
  )
}

/** 宿主会话插槽注入的选择器钩子（形状同 zustand 风格 selector）。 */
type Selector<S> = <R>(select: (state: S) => R) => R

interface SessionShape {
  blank?: boolean
  awaitingFirstTurn?: boolean
  running?: boolean
  promptAttempted?: boolean
  openState?: string
}

export interface SidechatConversationProps {
  sessionId: string
  useSession?: Selector<SessionShape>
  useConversation?: Selector<{ activeTargets?: { size: number } }>
  useSessions?: Selector<{ byId?: Record<string, { blank?: boolean } | undefined> }>
  renderFactorySlot?(name: string, props: object, options: { slots: Record<string, unknown> }): ReactNode
}

/** 固定显示「对话」视图（与宿主 FixedChatConversationView 一致）。 */
function FixedChatView(props: { renderSlot(name: string, props: object): ReactNode }) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

const ALWAYS_UNDEFINED = (): undefined => undefined

/**
 * 子插槽 dshws.sidechat.conversation 的内容：宿主 conversation.content 工厂（embedded 变体）。
 * phase / hero 的推导照抄宿主 ConversationSlotPanel（去掉子代理专有的父会话可用性判断）。
 * 钩子缺失（宿主版本不同）时按「无」处理 —— 同一个组件实例里钩子的有无不会变，调用顺序稳定。
 */
export function SidechatConversation(props: SidechatConversationProps) {
  const session = (props.useSession ?? (ALWAYS_UNDEFINED as unknown as Selector<SessionShape>))((v) => v) ?? {}
  const conversation = (props.useConversation ?? (ALWAYS_UNDEFINED as unknown as Selector<{ activeTargets?: { size: number } }>))((v) => v)
  const summaryBlank = (props.useSessions ?? (ALWAYS_UNDEFINED as unknown as Selector<{ byId?: Record<string, { blank?: boolean } | undefined> }>))(
    (s) => s.byId?.[props.sessionId]?.blank
  )
  if (props.renderFactorySlot === undefined) return null
  const active = (conversation?.activeTargets?.size ?? 0) > 0
  const shellPhase =
    active || (session.blank !== true && session.awaitingFirstTurn !== true) || session.running === true ? 'active' : session.promptAttempted === true ? 'engaging' : 'blank'
  const settling = shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  return (
    <>
      {props.renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero },
        { slots: { views: FixedChatView } }
      )}
    </>
  )
}

/** 会话页头「侧边对话」按钮（conversation.session.header.utilities）。 */
export function SidechatHeaderButton(props: SidechatInjected) {
  const { t, host, actions, sessionId } = props
  const list = useSessionList(host.sessionList())
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const pending = useForkPending()
  if (!host.available()) return null
  // 空会话没有可分叉的轮次；子代理会话由宿主子代理查看器负责，不提供侧边对话。
  const summary = list.byId[sessionId]
  if (summary?.blank === true || summary?.origin === 'subagent') return null
  // 第一轮进行中（已因 fork-unavailable 记住）：禁用并提示本轮结束后可创建，running 结束自动恢复。
  const waiting = forkBlocked(pending, summary)
  const title = waiting ? t('sidechat.waitTurn') : (error ?? (busy ? t('sidechat.creating') : t('sidechat.headerTitle')))
  return (
    <button
      type="button"
      className="dshws-head-btn"
      data-busy={busy}
      data-tone={error !== null && !waiting ? 'error' : undefined}
      title={title}
      aria-label={t('sidechat.headerTitle')}
      disabled={busy || waiting}
      onClick={() => {
        setBusy(true)
        setError(null)
        actions.start(sessionId).then(
          () => setBusy(false),
          (err: unknown) => {
            setBusy(false)
            setError(handleForkError(err, sessionId, host.sessionList(), t))
          }
        )
      }}
    >
      <IconSideChat />
    </button>
  )
}
