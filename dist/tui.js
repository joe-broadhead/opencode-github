// src/tui/index.tsx
import { createComponent as _$createComponent } from "@opentui/solid";
import { memo as _$memo } from "@opentui/solid";
import { createTextNode as _$createTextNode } from "@opentui/solid";
import { effect as _$effect } from "@opentui/solid";
import { insertNode as _$insertNode } from "@opentui/solid";
import { insert as _$insert } from "@opentui/solid";
import { setProp as _$setProp } from "@opentui/solid";
import { createElement as _$createElement } from "@opentui/solid";
import { TextAttributes } from "@opentui/core";
import { For, Show, createSignal } from "solid-js";

// src/rpc.ts
import { Rpc } from "@opencode/plugin/rpc";
var SERVER_NAME = "github";
var STATES = ["connected", "sign_in_required", "connecting", "failed", "disabled", "not_configured", "conflict"];
var EFFECTS = ["allow", "ask", "deny"];
var ACCESS = ["all", "ask-changes", "read-only"];
var UNKNOWN_TOOL_MODES = ["ask", "hide"];
var text = { type: "string" };
var texts = { type: "array", items: text };
var object = (properties, required) => ({ type: "object", properties, required, additionalProperties: false });
var rule = object({ action: text, resource: text, effect: { enum: EFFECTS } }, ["action", "resource", "effect"]);
var skillPath = object({ id: text, path: text }, ["id", "path"]);
var STATUS_SCHEMA = object(
  {
    version: text,
    state: { enum: STATES },
    account: text,
    access: { enum: ACCESS },
    deprecation: text,
    toolsets: texts,
    tools: object({ visible: { type: "integer", minimum: 0 }, unknown: texts, mode: { enum: UNKNOWN_TOOL_MODES } }, ["visible", "unknown", "mode"]),
    unguardedAgents: texts,
    unmatchedRules: texts,
    shadowedSkills: { type: "array", items: skillPath },
    permissionsBlock: { type: "array", items: rule },
    host: object({ version: text, range: text, tested: { type: "boolean" } }, ["version", "range", "tested"]),
    hostWarning: text,
    enterprise: text,
    nextStep: text
  },
  ["version", "state", "access", "toolsets", "tools", "unguardedAgents", "host", "nextStep"]
);
var GithubRpc = Rpc.define({
  id: "github.platform",
  methods: {
    status: {
      input: object({}, []),
      output: STATUS_SCHEMA,
      errors: { unavailable: object({ reason: text }, ["reason"]) }
    }
  },
  events: {}
});
var isRecord = (value) => typeof value === "object" && value !== null && !Array.isArray(value);
var isText = (value) => typeof value === "string";
var isTexts = (value) => Array.isArray(value) && value.every(isText);
var only = (value, keys) => Object.keys(value).every((key) => keys.includes(key));
var optional = (value, check) => value === void 0 || check(value);
var isSkillPath = (value) => isRecord(value) && only(value, ["id", "path"]) && isText(value.id) && isText(value.path);
var isRule = (value) => isRecord(value) && only(value, ["action", "resource", "effect"]) && isText(value.action) && isText(value.resource) && EFFECTS.includes(value.effect);
function isStatus(value) {
  if (!isRecord(value) || !only(value, Object.keys(STATUS_SCHEMA.properties))) return false;
  const { tools, host } = value;
  return isText(value.version) && STATES.includes(value.state) && optional(value.account, isText) && ACCESS.includes(value.access) && optional(value.deprecation, isText) && isTexts(value.toolsets) && isRecord(tools) && only(tools, ["visible", "unknown", "mode"]) && Number.isInteger(tools.visible) && tools.visible >= 0 && isTexts(tools.unknown) && UNKNOWN_TOOL_MODES.includes(tools.mode) && isTexts(value.unguardedAgents) && optional(value.unmatchedRules, isTexts) && optional(value.shadowedSkills, (skills) => Array.isArray(skills) && skills.every(isSkillPath)) && optional(value.permissionsBlock, (block) => Array.isArray(block) && block.every(isRule)) && isRecord(host) && only(host, ["version", "range", "tested"]) && isText(host.version) && isText(host.range) && typeof host.tested === "boolean" && optional(value.hostWarning, isText) && optional(value.enterprise, isText) && isText(value.nextStep);
}
var STATE_LABELS = {
  connected: "connected",
  sign_in_required: "sign-in required",
  connecting: "connecting",
  failed: "failed",
  disabled: "disabled",
  not_configured: "not configured",
  conflict: "conflict"
};
var NONE = "none";
function formatRules(rules) {
  return `[
${rules.map((rule2) => `  ${JSON.stringify(rule2)}`).join(",\n")}
]`;
}
function describeTools(status) {
  if (status.enterprise) return "github_api only. GitHub's hosted MCP tools do not support GitHub Enterprise Server; run github-mcp-server yourself for them.";
  const tools = status.tools;
  const visible = `${tools.visible} available`;
  if (tools.unknown.length === 0) return visible;
  const handling = tools.mode === "hide" ? "hidden" : status.access === "all" ? "allowed by github_*" : status.access === "ask-changes" ? "they ask first" : "they are denied";
  return `${visible}, ${tools.unknown.length} unknown (${handling}): ${tools.unknown.join(", ")}`;
}
function describeHost(status) {
  const { host } = status;
  if (host.tested) return `${host.version} (tested)`;
  if (status.hostWarning) return `${host.version} (untested: ${status.hostWarning})`;
  return `${host.version} (untested; supported range ${host.range})`;
}
var ACCESS_TEXT = {
  all: "every tool runs without asking, reads and new tools included",
  "ask-changes": "reads run without asking; every change and every new tool asks first",
  "read-only": "reads run without asking; every change and every new tool is denied"
};
function statusRows(status) {
  return [
    { label: "Connection", value: STATE_LABELS[status.state] },
    { label: "Account", value: status.account ?? NONE },
    { label: "Access", value: ACCESS_TEXT[status.access] },
    ...status.deprecation ? [{ label: "Note", value: status.deprecation }] : [],
    ...status.enterprise ? [] : [{ label: "Toolsets", value: status.toolsets.join(", ") }],
    { label: "Host", value: status.enterprise ? `${status.enterprise} (GitHub Enterprise Server)` : "github.com" },
    ...status.unmatchedRules?.length ? [{ label: "Rules that never match", value: status.unmatchedRules.join("; ") }] : [],
    ...status.shadowedSkills?.length ? [{ label: "Skills", value: status.shadowedSkills.map((skill) => `${skill.id} replaced by ${skill.path}`).join("; ") }] : [],
    { label: "Tools", value: describeTools(status) },
    { label: "Agents without default rules", value: status.unguardedAgents.length > 0 ? status.unguardedAgents.join(", ") : NONE },
    { label: "OpenCode", value: describeHost(status) },
    { label: "Next step", value: status.nextStep }
  ];
}

// src/tui/index.tsx
var TONES = {
  connected: "success",
  sign_in_required: "warning",
  connecting: "warning",
  failed: "error",
  disabled: "warning",
  not_configured: "error",
  conflict: "warning"
};
var REFRESH_EVENTS = ["integration.updated", "credential.updated", "credential.switched", "agent.updated", "server.connected"];
function Row(props) {
  return (() => {
    var _el$ = _$createElement("box"), _el$2 = _$createElement("text"), _el$3 = _$createElement("text");
    _$insertNode(_el$, _el$2);
    _$insertNode(_el$, _el$3);
    _$setProp(_el$, "flexDirection", "row");
    _$setProp(_el$, "gap", 1);
    _$setProp(_el$2, "width", 28);
    _$setProp(_el$2, "flexShrink", 0);
    _$insert(_el$2, () => props.label);
    _$setProp(_el$3, "flexGrow", 1);
    _$setProp(_el$3, "wrapMode", "word");
    _$insert(_el$3, () => props.value);
    _$effect((_p$) => {
      var _v$ = props.muted, _v$2 = props.fg;
      _v$ !== _p$.e && (_p$.e = _$setProp(_el$2, "fg", _v$, _p$.e));
      _v$2 !== _p$.t && (_p$.t = _$setProp(_el$3, "fg", _v$2, _p$.t));
      return _p$;
    }, {
      e: void 0,
      t: void 0
    });
    return _el$;
  })();
}
function StatusDialog(props) {
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [{
      title: "Refresh GitHub status",
      group: "GitHub",
      bind: "r",
      run: () => props.refresh()
    }, {
      title: "Close GitHub status",
      group: "GitHub",
      bind: "escape",
      run: () => props.context.ui.dialog.clear()
    }]
  }));
  const colors = () => props.context.theme.surface("dialog");
  const tone = (value) => colors().text.feedback[value].base;
  const ready = () => props.view.state === "ready" ? props.view.status : void 0;
  const rowColor = (row, status) => {
    if (row.label === "Connection") return tone(TONES[status.state]);
    if (row.label === "Rules that never match" || row.label === "Skills" || row.label === "Agents without default rules" && status.unguardedAgents.length > 0 || row.label === "OpenCode" && !status.host.tested) return tone("warning");
    return colors().text.base;
  };
  return (() => {
    var _el$4 = _$createElement("box"), _el$5 = _$createElement("box"), _el$6 = _$createElement("text"), _el$12 = _$createElement("text");
    _$insertNode(_el$4, _el$5);
    _$insertNode(_el$4, _el$12);
    _$setProp(_el$4, "flexDirection", "column");
    _$setProp(_el$4, "gap", 1);
    _$setProp(_el$4, "paddingLeft", 2);
    _$setProp(_el$4, "paddingRight", 2);
    _$setProp(_el$4, "paddingBottom", 1);
    _$insertNode(_el$5, _el$6);
    _$setProp(_el$5, "flexDirection", "row");
    _$setProp(_el$5, "justifyContent", "space-between");
    _$insertNode(_el$6, _$createTextNode(`GitHub status`));
    _$insert(_el$5, _$createComponent(Show, {
      get when() {
        return _$memo(() => !!props.refreshing)() && props.view.state !== "loading";
      },
      get children() {
        var _el$8 = _$createElement("text");
        _$insertNode(_el$8, _$createTextNode(`refreshing\u2026`));
        _$effect((_$p) => _$setProp(_el$8, "fg", colors().text.muted, _$p));
        return _el$8;
      }
    }), null);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return props.view.state === "loading";
      },
      get children() {
        var _el$0 = _$createElement("text");
        _$insertNode(_el$0, _$createTextNode(`Loading GitHub status\u2026`));
        _$effect((_$p) => _$setProp(_el$0, "fg", colors().text.muted, _$p));
        return _el$0;
      }
    }), _el$12);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return props.view.state === "unavailable";
      },
      get children() {
        var _el$10 = _$createElement("text");
        _$insertNode(_el$10, _$createTextNode(`GitHub status unavailable. Run /github-status for details.`));
        _$setProp(_el$10, "wrapMode", "word");
        _$effect((_$p) => _$setProp(_el$10, "fg", tone("error"), _$p));
        return _el$10;
      }
    }), _el$12);
    _$insert(_el$4, _$createComponent(Show, {
      get when() {
        return ready();
      },
      children: (status) => (() => {
        var _el$14 = _$createElement("box");
        _$setProp(_el$14, "flexDirection", "column");
        _$insert(_el$14, _$createComponent(For, {
          get each() {
            return statusRows(status());
          },
          children: (row) => [_$createComponent(Row, {
            get label() {
              return row.label;
            },
            get value() {
              return row.value;
            },
            get fg() {
              return rowColor(row, status());
            },
            get muted() {
              return colors().text.muted;
            }
          }), _$createComponent(Show, {
            get when() {
              return _$memo(() => row.label === "Agents without default rules")() && status().unguardedAgents.length > 0;
            },
            get children() {
              var _el$15 = _$createElement("box"), _el$16 = _$createElement("box"), _el$17 = _$createElement("scrollbox"), _el$18 = _$createElement("text");
              _$insertNode(_el$15, _el$16);
              _$insertNode(_el$15, _el$17);
              _$setProp(_el$15, "flexDirection", "row");
              _$setProp(_el$15, "gap", 1);
              _$setProp(_el$16, "width", 28);
              _$setProp(_el$16, "flexShrink", 0);
              _$insertNode(_el$17, _el$18);
              _$setProp(_el$17, "height", 8);
              _$setProp(_el$17, "flexGrow", 1);
              _$setProp(_el$17, "scrollY", true);
              _$insert(_el$18, () => formatRules(status().permissionsBlock ?? []));
              _$effect((_$p) => _$setProp(_el$18, "fg", colors().text.base, _$p));
              return _el$15;
            }
          })]
        }));
        return _el$14;
      })()
    }), _el$12);
    _$insertNode(_el$12, _$createTextNode(`r refresh \xB7 esc close`));
    _$effect((_p$) => {
      var _v$3 = colors().text.base, _v$4 = TextAttributes.BOLD, _v$5 = colors().text.muted;
      _v$3 !== _p$.e && (_p$.e = _$setProp(_el$6, "fg", _v$3, _p$.e));
      _v$4 !== _p$.t && (_p$.t = _$setProp(_el$6, "attributes", _v$4, _p$.t));
      _v$5 !== _p$.a && (_p$.a = _$setProp(_el$12, "fg", _v$5, _p$.a));
      return _p$;
    }, {
      e: void 0,
      t: void 0,
      a: void 0
    });
    return _el$4;
  })();
}
var index_default = {
  id: "github.platform.tui",
  setup(context) {
    const [view, setView] = createSignal({
      state: "loading"
    });
    const [refreshing, setRefreshing] = createSignal(false);
    let generation = 0;
    let controller;
    let open;
    let disposed = false;
    let unsubscribe = [];
    const stopListening = () => {
      for (const stop of unsubscribe.splice(0)) stop();
    };
    const listen = () => {
      stopListening();
      unsubscribe = [context.data.on("mcp.status.changed", (event) => {
        if (event.data.server === SERVER_NAME) refresh();
      }), ...REFRESH_EVENTS.map((type) => context.data.on(type, refresh))];
    };
    const cancel = () => {
      generation++;
      controller?.abort();
      controller = void 0;
    };
    const refresh = () => {
      if (!open) return;
      cancel();
      const request = generation;
      const current = new AbortController();
      controller = current;
      setRefreshing(true);
      void context.client.rpc(GithubRpc).status({}, {
        location: context.location ?? context.data.location.default(),
        signal: current.signal
      }).then((output) => isStatus(output) ? {
        state: "ready",
        status: output
      } : {
        state: "unavailable"
      }, () => ({
        state: "unavailable"
      })).then((next) => {
        if (request !== generation) return;
        controller = void 0;
        setView(next);
        setRefreshing(false);
      });
    };
    const show = () => {
      if (disposed) return;
      const token = {};
      setView({
        state: "loading"
      });
      context.ui.dialog.show(() => _$createComponent(StatusDialog, {
        context,
        get view() {
          return view();
        },
        get refreshing() {
          return refreshing();
        },
        refresh
      }), () => {
        if (open !== token) return;
        open = void 0;
        stopListening();
        cancel();
      });
      context.ui.dialog.set({
        size: "large"
      });
      open = token;
      listen();
      refresh();
    };
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "github.status",
        title: "GitHub: Status",
        description: "Show whether GitHub is connected, the account and what to do next",
        group: "GitHub",
        palette: true,
        slash: {
          name: "github"
        },
        run: show
      }]
    }));
    return () => {
      disposed = true;
      stopListening();
      cancel();
      if (open) {
        open = void 0;
        context.ui.dialog.clear();
      }
    };
  }
};
export {
  index_default as default
};
