/*
 * @Description: 侧边对话（方案 3.8）的注册 —— 资源协议、右侧栏标签类型、标签正文 + 自声明子插槽、会话页头按钮
 * @Author: YangHeng
 * @Date: 2026-10-10 20:00:00
 * @FilePath: /dsh-workspace/src/client/sidechat/register.ts
 *
 * 受「侧边栏」管理页的 sidechat 开关控制（关 = 全部撤下，开 = 重新注册，不用刷新）。
 * 等 resources / sidebarRightTabs / sessions 三个服务都提供后才注册；服务重建时随子作用域撤下并重挂。
 * 任何一步失败只记日志：入口随之不出现，插件其他功能不受影响。
 */
import { createElement } from 'react'
import type { ClientContext, Translate } from '../context.js'
import type { WorkspaceApi } from '../api.js'
import { getSidebarPrefs, saveSidebarPrefs, subscribeSidebarPrefs } from '../sidebar-prefs.js'
import { addSidechat, removeSidechat } from '../../wire/sidebar-prefs.js'
import { SIDECHAT_KIND } from '../sidebar/kinds.js'
import { SIDECHAT_PATTERN, SIDECHAT_PROTOCOL, parseSidechatAddress } from './address.js'
import { RETAIN_SOURCE, createSidechatHost, probeSessions, type SidechatHost } from './host.js'
import { SIDECHAT_CONVERSATION_SLOT, SidechatConversation, SidechatHeaderButton, SidechatTab, type SidechatActions } from './SidechatTab.js'

interface Scope {
  get(name: string): unknown
  effect(f: () => () => void, label?: string): unknown
}

interface TabRegistry {
  register(definition: {
    id: string
    kind: string
    multiple?: boolean
    patterns?: readonly string[]
    priority?: 'extension' | 'builtin' | 'fallback'
    canOpen?: (address: string) => boolean
    title: (address: string) => string
    guide?: ReadonlyArray<{ id: string; order: number; title: () => string; description?: () => string; icon?: (p: { size?: number }) => unknown }>
  }): () => void
}

interface ResourceRegistry {
  register(provider: { protocol: string; open(address: string, options: { signal: AbortSignal }): AsyncGenerator<unknown, void, unknown> }): () => void
}

const ICON = (p: { size?: number }) => {
  const size = typeof p.size === 'number' ? p.size : 16
  return createElement(
    'svg',
    { width: size, height: size, viewBox: '0 0 16 16', fill: 'none', 'aria-hidden': true },
    createElement('path', {
      d: 'M2.5 3.5h7a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H6l-2.5 2v-2h-1a1 1 0 0 1-1-1v-4a1 1 0 0 1 1-1z M12.5 6.5h1a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1h-1v1.8L10.3 12.5H8a1 1 0 0 1-1-1',
      stroke: 'currentColor',
      strokeWidth: 1.3,
      strokeLinecap: 'round',
      strokeLinejoin: 'round'
    })
  )
}

function waitForAbort(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve()
  return new Promise((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
}

/**
 * 资源提供方：打开期间持有子会话引用（交给 SessionProvider），标签关闭（signal abort）时释放。
 * 会话已删除时 retain 抛错 —— 转成失败帧，正文显示「会话不存在」并给出「移除记录」。
 */
export function sidechatResourceProvider(sessions: () => ReturnType<typeof probeSessions>) {
  return {
    protocol: SIDECHAT_PROTOCOL,
    async *open(resourceAddress: string, { signal }: { signal: AbortSignal }): AsyncGenerator<unknown, void, unknown> {
      const address = parseSidechatAddress(resourceAddress)
      if (address === undefined) {
        yield { ok: false, error: new Error(`dshws-sidechat: invalid address "${resourceAddress}"`) }
        return
      }
      if (signal.aborted) return
      const svc = sessions()
      if (svc === undefined) {
        yield { ok: false, error: new Error('sessions.retain unavailable') }
        return
      }
      let reference
      try {
        reference = svc.retain(address.childId, { source: RETAIN_SOURCE, signal })
      } catch (error) {
        yield { ok: false, error }
        return
      }
      try {
        yield { ok: true, value: { address, reference } }
        await waitForAbort(signal)
      } finally {
        reference.release()
      }
    }
  }
}

/** 侧边对话的动作：分叉 → 记录来源 → 侧栏打开；移除记录；删除（归档左侧会话 → 关标签 → 移除记录）。 */
export function createSidechatActions(host: SidechatHost, api: WorkspaceApi, log: (m: string, e?: unknown) => void, now: () => number = Date.now): SidechatActions {
  return {
    async start(parentId) {
      const childId = await host.fork(parentId)
      // 记录失败不影响已经建好的会话（只是线程列表里少一条）：记日志继续打开。
      try {
        await saveSidebarPrefs(api, { sidechats: addSidechat(getSidebarPrefs().sidechats, { parentId, childId, createdAt: now() }) })
      } catch (error) {
        log('记录侧边对话失败', error)
      }
      if (!host.openAside(childId, parentId)) host.openMain(childId)
    },
    async remove(childId) {
      await saveSidebarPrefs(api, { sidechats: removeSidechat(getSidebarPrefs().sidechats, childId) })
    },
    async delete(childId, options) {
      // 先动宿主：失败（含「会话仍在运行」的拒绝）直接抛给界面，记录保持不动，避免出现「记录没了、会话还在」。
      await host.archive(childId, options)
      try {
        host.closeTabsOf(childId)
      } catch (error) {
        log('关闭侧边对话标签失败', error)
      }
      await saveSidebarPrefs(api, { sidechats: removeSidechat(getSidebarPrefs().sidechats, childId) })
    }
  }
}

export function registerSidechat(ctx: ClientContext, deps: { t: Translate; api: WorkspaceApi }, log: (m: string, e?: unknown) => void): () => void {
  const { t, api } = deps
  const c = ctx as unknown as {
    inject?(names: string[], cb: (sub: Scope) => void): { dispose(): void } | (() => void)
  }
  if (typeof c.inject !== 'function') {
    log('宿主不支持 ctx.inject，跳过侧边对话')
    return () => undefined
  }
  const host = createSidechatHost(ctx, log)
  const actions = createSidechatActions(host, api, log)
  const inject = (sessionId: string) => ({ t, host, actions, sessionId })

  const mount = (sub: Scope): (() => void) => {
    const tabs = sub.get('sidebarRightTabs') as TabRegistry | undefined
    const resources = sub.get('resources') as ResourceRegistry | undefined
    if (tabs === undefined || typeof tabs.register !== 'function' || resources === undefined || typeof resources.register !== 'function') {
      log('宿主缺少右侧栏 / 资源服务，跳过侧边对话')
      return () => undefined
    }
    if (probeSessions(sub.get('sessions')) === undefined) {
      log('宿主 sessions 不支持 fork / retain，跳过侧边对话')
      return () => undefined
    }
    const offs: Array<() => void> = []
    const run = (label: string, fn: () => () => void): boolean => {
      try {
        offs.push(fn())
        return true
      } catch (error) {
        log(`注册侧边对话「${label}」失败`, error)
        return false
      }
    }
    const sessionsOf = () => probeSessions(ctx.get('sessions'))
    // 资源提供方是嵌入的前提：失败就不注册任何入口（否则会出现打不开的标签）。
    if (!run('资源协议', () => resources.register(sidechatResourceProvider(sessionsOf)))) return () => offs.reverse().forEach((f) => f())
    run('标签类型', () =>
      tabs.register({
        id: SIDECHAT_KIND,
        kind: SIDECHAT_KIND,
        multiple: true,
        priority: 'extension',
        patterns: [SIDECHAT_PATTERN],
        canOpen: (address) => parseSidechatAddress(address) !== undefined,
        title: (address) => {
          const child = parseSidechatAddress(address)?.childId
          if (child === undefined) return t('sidechat.tabTitle')
          return host.sessionList()?.getSnapshot().byId[child]?.displayTitle ?? t('sidechat.label')
        },
        guide: [{ id: SIDECHAT_KIND, order: 43, title: () => t('sidechat.tabTitle'), description: () => t('sidechat.guideHint'), icon: ICON }]
      })
    )
    // 标签正文：声明会话作用域子插槽，框架才会注入 SessionProvider / renderSlot（见宿主 ui-slots standardKit）。
    run('标签正文', () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: SIDECHAT_KIND,
            inject: inject as never,
            children: { [SIDECHAT_CONVERSATION_SLOT]: { kind: 'single', scope: 'session' } }
          } as never,
          SidechatTab as never
        )
      )
    )
    run('嵌入会话', () =>
      ctx.slots.inject(SIDECHAT_CONVERSATION_SLOT, () => ctx.slots.register({ name: SIDECHAT_CONVERSATION_SLOT } as never, SidechatConversation as never))
    )
    run('页头按钮', () =>
      ctx.slots.inject('conversation.session.header.utilities', () =>
        ctx.slots.register(
          { name: 'conversation.session.header.utilities', id: 'dshws-sidechat', order: 10, inject: inject as never } as never,
          SidechatHeaderButton as never
        )
      )
    )
    return () => {
      for (const off of offs.reverse()) {
        try {
          off()
        } catch (error) {
          log('撤销侧边对话注册失败', error)
        }
      }
    }
  }

  const fiber = c.inject(['resources', 'sidebarRightTabs', 'sessions'], (sub) => {
    let off: (() => void) | undefined
    const sync = (): void => {
      const on = getSidebarPrefs().tabs.sidechat
      if (on && off === undefined) off = mount(sub)
      else if (!on && off !== undefined) {
        off()
        off = undefined
      }
    }
    try {
      sub.effect(() => {
        sync()
        const unsubscribe = subscribeSidebarPrefs(sync)
        return () => {
          unsubscribe()
          off?.()
          off = undefined
        }
      }, 'dsh-workspace: sidechat')
    } catch (error) {
      log('注册侧边对话失败', error)
    }
  })
  return () => {
    if (typeof fiber === 'function') fiber()
    else fiber.dispose()
  }
}
