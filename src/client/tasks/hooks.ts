/*
 * @Description: 任务页的 React 钩子 —— 可见性、会话列表 / 任务名册订阅、页签可见时轮询网关
 * @Author: YangHeng
 * @Date: 2026-10-10 18:00:00
 * @FilePath: /dsh-workspace/src/client/tasks/hooks.ts
 */
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react'
import type { JobsService, JobsSnapshot, SessionListSnapshot, SessionListStore } from './host.js'

const EMPTY_LIST: SessionListSnapshot = { byId: {} }
const EMPTY_JOBS: JobsSnapshot = { rows: {}, observed: {} }

export function useSessionList(store: SessionListStore | undefined): SessionListSnapshot {
  const subscribe = useMemo(() => (cb: () => void) => (store === undefined ? () => undefined : store.subscribe(cb)), [store])
  const read = useCallback(() => (store === undefined ? EMPTY_LIST : (store.getSnapshot() ?? EMPTY_LIST)), [store])
  return useSyncExternalStore(subscribe, read, read)
}

export function useJobsSnapshot(jobs: JobsService | undefined): JobsSnapshot {
  const subscribe = useMemo(() => (cb: () => void) => (jobs === undefined ? () => undefined : jobs.state.subscribe(cb)), [jobs])
  const read = useCallback(() => (jobs === undefined ? EMPTY_JOBS : (jobs.state.getSnapshot() ?? EMPTY_JOBS)), [jobs])
  return useSyncExternalStore(subscribe, read, read)
}

/**
 * 元素是否在屏幕上：右侧栏切到别的标签时本页不卸载只隐藏，此时停止轮询 / 退订名册。
 * 没有 IntersectionObserver 的环境恒为可见。
 */
export function useVisible(ref: RefObject<HTMLElement | null>): boolean {
  const [visible, setVisible] = useState(true)
  const [docVisible, setDocVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden')
  useEffect(() => {
    const el = ref.current
    if (el === null || typeof IntersectionObserver === 'undefined') return undefined
    const io = new IntersectionObserver((entries) => setVisible(entries.some((e) => e.isIntersecting)))
    io.observe(el)
    return () => io.disconnect()
  }, [ref])
  useEffect(() => {
    if (typeof document === 'undefined') return undefined
    const on = (): void => setDocVisible(document.visibilityState !== 'hidden')
    document.addEventListener('visibilitychange', on)
    return () => document.removeEventListener('visibilitychange', on)
  }, [])
  return visible && docVisible
}

export interface PollState<T> {
  data: T | null
  error: string | null
}

/**
 * 页签可见时每 interval 毫秒调用一次（立即先调一次）；key 变化时丢弃旧结果。
 * 内容没变（JSON 相同）不触发重渲染；慢请求的过期返回按序号丢弃。
 */
export function usePoll<T>(fetcher: (() => Promise<T>) | undefined, key: string, active: boolean, interval = 3000): [PollState<T>, () => void] {
  const [state, setState] = useState<PollState<T>>({ data: null, error: null })
  const json = useRef('')
  const seq = useRef(0)
  // 定时轮询时上一次还没返回就跳过，宿主慢时不堆积请求；手动刷新（返回的 run）不受限
  const inflight = useRef(false)
  const fetcherRef = useRef(fetcher)
  fetcherRef.current = fetcher
  const run = useCallback(() => {
    const f = fetcherRef.current
    if (f === undefined) return
    const mine = ++seq.current
    inflight.current = true
    f().finally(() => {
      if (mine === seq.current) inflight.current = false
    }).then(
      (data) => {
        if (mine !== seq.current) return
        const next = JSON.stringify(data)
        if (next === json.current) return
        json.current = next
        setState({ data, error: null })
      },
      (error: unknown) => {
        if (mine !== seq.current) return
        json.current = ''
        setState((s) => ({ data: s.data, error: error instanceof Error ? error.message : String(error) }))
      }
    )
  }, [])
  useEffect(() => {
    json.current = ''
    seq.current += 1
    inflight.current = false
    setState({ data: null, error: null })
  }, [key])
  useEffect(() => {
    if (!active || fetcher === undefined) return undefined
    run()
    const timer = setInterval(() => {
      if (!inflight.current) run()
    }, interval)
    return () => clearInterval(timer)
    // fetcher 每次渲染都是新函数：只按 key / active 重启轮询，取最新 fetcher 走 ref。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, active, interval, run, fetcher === undefined])
  return [state, run]
}

/** 每秒刷新一次的「现在」（运行中任务的时长）；inactive 时不走表。 */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return undefined
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [active])
  return now
}
