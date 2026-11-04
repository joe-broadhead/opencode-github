// The TUI part: the /github status view. It shows the same status as /github-status, read
// through the plugin's one RPC method, and refreshes on r and whenever OpenCode reports a
// change to the github server, its sign-in, the saved accounts or the agents. scripts/build.mjs compiles and
// bundles it, with the RPC contract inlined, into dist/tui.js, so no .tsx ships or runs from node_modules.
import type { Plugin } from "@opencode/plugin/tui"
import { type RGBA, TextAttributes } from "@opentui/core"
import { For, Show, createSignal } from "solid-js"
import { AGENT_FIX, GithubRpc, SERVER_NAME, type Status, type StatusRow, isStatus, formatRules, statusRows } from "../rpc.js"

type View = { readonly state: "loading" } | { readonly state: "ready"; readonly status: Status } | { readonly state: "unavailable" }

type Tone = "success" | "warning" | "error"

/** The colours of the dialog surface that this view uses. */
type Colors = {
  readonly text: {
    readonly base: RGBA
    readonly muted: RGBA
    readonly feedback: Readonly<Record<Tone, { readonly base: RGBA }>>
  }
}

const TONES: Record<Status["state"], Tone> = {
  connected: "success",
  sign_in_required: "warning",
  connecting: "warning",
  failed: "error",
  disabled: "warning",
  not_configured: "error",
  conflict: "warning",
}

/** Events that can change the view, besides mcp.status.changed for the github server. */
const REFRESH_EVENTS = ["integration.updated", "credential.updated", "credential.switched", "agent.updated", "server.connected"] as const
const LABEL_WIDTH = 28

/** Shown for every failure. Error details stay out of the view; /github-status reports them. */
const UNAVAILABLE = "GitHub status unavailable. Run /github-status for details."
/** Rows of the rules block shown before it scrolls. */
const RULES_HEIGHT = 8

function Row(props: { readonly label: string; readonly value: string; readonly fg: RGBA; readonly muted: RGBA }) {
  return (
    <box flexDirection="row" gap={1}>
      <text fg={props.muted} width={LABEL_WIDTH} flexShrink={0}>
        {props.label}
      </text>
      <text fg={props.fg} flexGrow={1} wrapMode="word">
        {props.value}
      </text>
    </box>
  )
}

function StatusDialog(props: {
  readonly context: Plugin.Context
  readonly view: View
  readonly refreshing: boolean
  readonly refresh: () => void
}) {
  // Created inside the dialog, so OpenCode removes these keys when the dialog closes.
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { title: "Refresh GitHub status", group: "GitHub", bind: "r", run: () => props.refresh() },
      { title: "Close GitHub status", group: "GitHub", bind: "escape", run: () => props.context.ui.dialog.clear() },
    ],
  }))
  const colors = (): Colors => props.context.theme.surface("dialog")
  const tone = (value: Tone) => colors().text.feedback[value].base
  const ready = () => (props.view.state === "ready" ? props.view.status : undefined)
  const rowColor = (row: StatusRow, status: Status) => {
    if (row.label === "Connection") return tone(TONES[status.state])
    if ((row.label === "Agents without default rules" && status.unguardedAgents.length > 0) || (row.label === "OpenCode" && !status.host.tested)) return tone("warning")
    return colors().text.base
  }
  return (
    <box flexDirection="column" gap={1} paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={colors().text.base} attributes={TextAttributes.BOLD}>
          GitHub status
        </text>
        <Show when={props.refreshing && props.view.state !== "loading"}>
          <text fg={colors().text.muted}>refreshing…</text>
        </Show>
      </box>
      <Show when={props.view.state === "loading"}>
        <text fg={colors().text.muted}>Loading GitHub status…</text>
      </Show>
      <Show when={props.view.state === "unavailable"}>
        <text fg={tone("error")} wrapMode="word">
          {UNAVAILABLE}
        </text>
      </Show>
      <Show when={ready()}>
        {(status) => (
          <box flexDirection="column">
            <For each={statusRows(status())}>
              {(row) => (
                <>
                  <Row label={row.label} value={row.value} fg={rowColor(row, status())} muted={colors().text.muted} />
                  <Show when={row.label === "Agents without default rules" && status().unguardedAgents.length > 0}>
                    <Row label="" value={AGENT_FIX} fg={colors().text.base} muted={colors().text.muted} />
                    <box flexDirection="row" gap={1}>
                      <box width={LABEL_WIDTH} flexShrink={0} />
                      <scrollbox height={RULES_HEIGHT} flexGrow={1} scrollY>
                        <text fg={colors().text.base}>{formatRules(status().permissionsBlock ?? [])}</text>
                      </scrollbox>
                    </box>
                  </Show>
                </>
              )}
            </For>
          </box>
        )}
      </Show>
      <text fg={colors().text.muted}>{"r refresh · esc close"}</text>
    </box>
  )
}

export default {
  id: "github.platform.tui",
  setup(context) {
    const [view, setView] = createSignal<View>({ state: "loading" })
    const [refreshing, setRefreshing] = createSignal(false)
    // Only the newest request may update the view; closing the view and cleanup also move it on.
    let generation = 0
    let controller: AbortController | undefined
    // Identifies the open dialog; showing another dialog closes this one.
    let open: object | undefined
    let disposed = false
    // Event listeners, only while the dialog is open.
    let unsubscribe: Array<() => void> = []
    const stopListening = () => {
      for (const stop of unsubscribe.splice(0)) stop()
    }
    const listen = () => {
      stopListening()
      unsubscribe = [
        context.data.on("mcp.status.changed", (event) => {
          if (event.data.server === SERVER_NAME) refresh()
        }),
        ...REFRESH_EVENTS.map((type) => context.data.on(type, refresh)),
      ]
    }

    const cancel = () => {
      generation++
      controller?.abort()
      controller = undefined
    }

    const refresh = () => {
      if (!open) return
      cancel()
      const request = generation
      const current = new AbortController()
      controller = current
      setRefreshing(true)
      void context.client
        .rpc(GithubRpc)
        .status({}, { location: context.location ?? context.data.location.default(), signal: current.signal })
        .then(
          (output): View => (isStatus(output) ? { state: "ready", status: output } : { state: "unavailable" }),
          (): View => ({ state: "unavailable" }),
        )
        .then((next) => {
          if (request !== generation) return
          controller = undefined
          setView(next)
          setRefreshing(false)
        })
    }

    const show = () => {
      if (disposed) return
      const token = {}
      setView({ state: "loading" })
      context.ui.dialog.show(
        () => <StatusDialog context={context} view={view()} refreshing={refreshing()} refresh={refresh} />,
        () => {
          if (open !== token) return
          open = undefined
          stopListening()
          cancel()
        },
      )
      context.ui.dialog.set({ size: "large" })
      open = token
      listen()
      refresh()
    }

    // Registered from setup, outside any root of the plugin's own, where OpenCode's keymap is
    // available. Global, so the palette, which runs in its own input mode, lists the command.
    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "github.status",
          title: "GitHub: Status",
          description: "Show whether GitHub is connected, the account and what to do next",
          group: "GitHub",
          palette: true,
          slash: { name: "github" },
          run: show,
        },
      ],
    }))

    return () => {
      disposed = true
      stopListening()
      cancel()
      if (open) {
        open = undefined
        context.ui.dialog.clear()
      }
    }
  },
} satisfies Plugin.Definition
