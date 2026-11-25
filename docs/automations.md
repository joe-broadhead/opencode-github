# Automations

An events source is read with a cursor in OpenCode automation state. The suggested cadence is a hint for the
automation, not a schedule the plugin sets.

<!-- generated:automations -->
| Source | Method | Provider floor | Suggested | Signals |
|---|---|---|---|---|
| `github.activity` | `tools.github.events_list` | — | 2 min | `bus` |
<!-- /generated:automations -->

## Reading with a cursor

Call `tools.github.events_list` with `{ "account": "work" }`, keep the `cursor` it answers in the automation's state,
and pass that cursor with the same account on the next run. A cursor never moves between accounts: one issued for
`work` is refused for `personal` with `CURSOR_INVALID`.

The read lists an item once it is five minutes old, so the index has settled, and pins that cut for the whole read. A
plain read without a cursor starts at `since` or 24 hours ago. When GitHub's notifications retention is exceeded, the
page answers a `gap` with the time it restarts from; render the gap, never invent the missing items.

Subscribe to `rpc.github.changed` to re-read sooner: the plugin emits it after its own `api` write. The event carries no
content; re-read the source through `events_list`.

## A recipe

```ts
// In OpenCode automation state, keep one cursor per alias.
const page = await tools.github.events_list({ account: "work", cursor: state.cursor })
for (const event of page.events) await apply(event)
if ((page.failed ?? []).length === 0) state.cursor = page.cursor
if (page.gap) state.gap = page.gap
```
