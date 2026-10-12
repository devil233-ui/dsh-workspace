/*
 * @Description: 窄屏（手机 / 小窗口）判断 —— 主区整页用视口宽度；右侧栏请继续用 Split 的容器宽度判断
 * @Author: YangHeng
 * @FilePath: /dsh-workspace/src/client/narrow.ts
 *
 * 为什么主区可以用视口宽度：主区整页（远程工作区页面）永远铺满主区，窗口窄 = 主区窄。
 * 右侧栏不同（可拖宽、还被会话顶部标签挤压），所以那边用 ResizeObserver 量容器（见 sidebar/Split.tsx）。
 */
import { useEffect, useState } from 'react'

/** 与 styles.ts 里 `@media (max-width: 640px)` 保持一致，改一处要同时改另一处。 */
export const NARROW_MAX_WIDTH = 640

/**
 * 「移动端」判断：窄屏或没有悬停能力的设备（触屏手机 / 平板）。与 styles.ts 里 `@media (hover: none), (max-width: 640px)` 一致。
 * 为什么不只看宽度：横屏平板宽度够，但没有鼠标悬停，悬停浮窗同样用不了。
 */
export const MOBILE_QUERY = `(hover: none), (max-width: ${NARROW_MAX_WIDTH}px)`

/** 视口是否为窄屏；无 window（SSR / 单测）时恒为 false。 */
export function useNarrow(max = NARROW_MAX_WIDTH): boolean {
  return useMediaQuery(`(max-width: ${max}px)`)
}

/** 任意媒体查询是否命中（随窗口变化更新）；无 window（SSR / 单测）时恒为 false。 */
export function useMediaQuery(query: string): boolean {
  const [narrow, setNarrow] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches
  )
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined
    const media = window.matchMedia(query)
    const onChange = (): void => setNarrow(media.matches)
    onChange()
    media.addEventListener('change', onChange)
    return () => media.removeEventListener('change', onChange)
  }, [query])
  return narrow
}
