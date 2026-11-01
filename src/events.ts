// Event helpers shared by the parts that follow OpenCode's event stream.
import type { OpenCodeEvent } from "@opencode/client"
import type { Plugin } from "@opencode/plugin"

type Subscribe = Plugin.Context["event"]["subscribe"]
type EventType = OpenCodeEvent["type"]
type Event<T extends EventType> = Extract<OpenCodeEvent, { type: T }>

/** Calls `handle` for each event of `types` until `signal` aborts or the stream ends. */
export async function forEachEvent<T extends Exclude<EventType, "server.connected">>(
  subscribe: Subscribe,
  types: readonly T[],
  signal: AbortSignal,
  handle: (event: Event<T>) => void,
): Promise<void> {
  const iterator = subscribe({ types, signal })[Symbol.asyncIterator]()
  let stop = () => {}
  const aborted = new Promise<undefined>((resolve) => {
    stop = () => resolve(undefined)
  })
  signal.addEventListener("abort", stop, { once: true })
  try {
    while (!signal.aborted) {
      // Waiting on the abort too: a pending next() is not guaranteed to settle on return().
      const result = await Promise.race([iterator.next(), aborted])
      if (!result || result.done) return
      handle(result.value as Event<T>)
    }
  } finally {
    signal.removeEventListener("abort", stop)
    void iterator.return?.()?.catch(() => undefined)
  }
}

/** Waits `ms`, or less if `signal` aborts first. Never rejects. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const done = () => {
      clearTimeout(timer)
      signal.removeEventListener("abort", done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal.addEventListener("abort", done, { once: true })
  })
}
