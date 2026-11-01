// A narrow fake of the TUI context, typed against the public @opencode/plugin/tui 2.2.3 API,
// with the OpenTUI test renderer standing in for OpenCode's dialog host. No host source.
import type { Plugin } from "@opencode/plugin/tui"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { getOwner, onCleanup } from "solid-js"

type Context = Plugin.Context
type Layer = ReturnType<Parameters<Context["keymap"]["layer"]>[0]>
type Command = NonNullable<Layer["commands"]>[number]
type Location = NonNullable<Context["location"]>
type Screen = Awaited<ReturnType<typeof testRender>>

type FakeContext = Pick<Context, "location"> & {
  // Not Pick<Context, "theme">: with @opencode/theme installed that is the full theme.
  readonly theme: typeof theme
  readonly client: Pick<Context["client"], "rpc">
  readonly data: Pick<Context["data"], "on"> & { readonly location: Pick<Context["data"]["location"], "default"> }
  readonly keymap: Pick<Context["keymap"], "layer">
  readonly ui: { readonly dialog: Pick<Context["ui"]["dialog"], "show" | "set" | "clear"> }
}

export const LOCATION = { directory: "/tmp/github-tui-test" } as Location
export const DEFAULT_LOCATION = { directory: "/tmp/github-tui-default" } as Location

/** One status call, which the test settles. */
export interface Call {
  readonly rpcID: string
  readonly input: unknown
  readonly options: { readonly location?: unknown; readonly signal?: AbortSignal }
  readonly resolve: (output: unknown) => void
  readonly reject: (error: unknown) => void
}

const gray = RGBA.fromInts(128, 128, 128, 255)
const feedback = { base: gray, muted: gray }
// The view reads only the text colours of the dialog surface.
const theme = {
  text: { base: gray, muted: gray, faint: gray, feedback: { success: feedback, warning: feedback, error: feedback, info: feedback } },
  surface: () => theme,
}

export function fakeContext({ location }: { readonly location: Location | undefined } = { location: LOCATION }) {
  const calls: Call[] = []
  const layers = new Set<Layer>()
  const handlers = new Map<string, Set<(event: unknown) => void>>()
  const dialog = {
    open: undefined as { readonly render: () => unknown; readonly onClose?: () => void } | undefined,
    screen: undefined as Screen | undefined,
    size: undefined as string | undefined,
  }

  // OpenCode destroys a dialog's view and calls its onClose when the dialog is cleared or replaced.
  const close = () => {
    const current = dialog.open
    dialog.open = undefined
    dialog.screen?.renderer.destroy()
    dialog.screen = undefined
    current?.onClose?.()
  }

  // The real client rejects with the fetch AbortError when the signal aborts.
  const rpc = ((definition: { readonly id: string }) => ({
    status: (input: unknown, options: Call["options"] = {}) =>
      new Promise((resolve, reject) => {
        options.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted.", "AbortError")))
        calls.push({ rpcID: definition.id, input, options, resolve, reject })
      }),
  })) as unknown as Context["client"]["rpc"]

  const on = ((type: string, handler: (event: unknown) => void) => {
    const set = handlers.get(type) ?? new Set()
    handlers.set(type, set)
    const listener = (event: unknown) => handler(event)
    set.add(listener)
    return () => void set.delete(listener)
  }) as Context["data"]["on"]

  const context: FakeContext = {
    location,
    theme,
    client: { rpc },
    data: { on, location: { default: () => DEFAULT_LOCATION } },
    keymap: {
      layer: (factory) => {
        const layer = factory()
        layers.add(layer)
        // OpenCode removes a layer when the component that created it is disposed.
        if (getOwner()) onCleanup(() => layers.delete(layer))
      },
    },
    ui: {
      dialog: {
        show: (render, onClose) => {
          close()
          dialog.open = { render, onClose }
        },
        set: (options) => {
          dialog.size = options.size
        },
        clear: close,
      },
    },
  }

  const commands = () => [...layers].flatMap((layer) => (layer.commands ?? []).map((command) => ({ layer, command })))
  const find = (key: string) => commands().find(({ command }) => command.bind === key || command.id === key)

  return {
    context,
    calls,
    dialog,
    /** Finds a reachable command by its key binding or id. */
    command(key: string): Command {
      const found = find(key)
      if (!found) throw new Error(`no command ${key}`)
      return found.command
    },
    hasCommand: (key: string) => find(key) !== undefined,
    layerOf: (key: string) => find(key)?.layer,
    /** Event types with at least one listener. */
    subscribed: () => [...handlers].filter(([, set]) => set.size > 0).map(([type]) => type),
    emit(type: string, data: unknown = {}) {
      for (const listener of handlers.get(type) ?? []) listener({ type, data })
    },
    /** Renders the open dialog with the OpenTUI test renderer and returns its text. */
    async frame() {
      if (!dialog.open) throw new Error("no dialog is open")
      const open = dialog.open
      dialog.screen ??= await testRender(() => open.render() as ReturnType<Parameters<typeof testRender>[0]>, { width: 110, height: 30 })
      await dialog.screen.renderOnce()
      return dialog.screen.captureCharFrame()
    },
  }
}

/** Lets promise chains settle. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
