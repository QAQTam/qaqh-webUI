/**
 * 极简外部 store（useSyncExternalStore 绑定）：
 * SSE 高频写入走 store，React 只订阅所需切片，避免每 delta 重渲染全树。
 */
import { useSyncExternalStore } from 'react';

export interface Store<T> {
  get(): T;
  set(next: T | ((prev: T) => T)): void;
  subscribe(fn: () => void): () => void;
}

/** 只读视图（协变）：useStore 只需要读与订阅 */
export interface ReadStore<T> {
  get(): T;
  subscribe(fn: () => void): () => void;
}

export function createStore<T>(initial: T): Store<T> {
  let state = initial;
  const subs = new Set<() => void>();
  return {
    get: () => state,
    set(next) {
      state = typeof next === 'function' ? (next as (prev: T) => T)(state) : next;
      for (const fn of subs) fn();
    },
    subscribe(fn) {
      subs.add(fn);
      return () => subs.delete(fn);
    },
  };
}

export function useStore<T, S>(store: ReadStore<T>, selector: (s: T) => S): S {
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.get()),
    () => selector(store.get()),
  );
}

/** 不可变替换数组内元素 */
export function mapItem<T>(list: readonly T[], pred: (t: T) => boolean, fn: (t: T) => T): T[] {
  const idx = list.findIndex(pred);
  if (idx === -1) return [...list];
  const next = [...list];
  next[idx] = fn(next[idx]);
  return next;
}
