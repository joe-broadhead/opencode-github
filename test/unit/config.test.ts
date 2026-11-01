import { describe, expect, it } from "vitest"
import { DEFAULT_TOOLSETS, GITHUB_COM, MCP_URL, TOOLSETS, endpoints, loadOptions } from "../../src/config.js"
import { SERVER_NAME } from "../../src/rpc.js"
import { GitHubPluginError } from "../../src/errors.js"
import { HIDDEN, KNOWN_TOOLS } from "../../src/tools.js"

function failure(raw: unknown): GitHubPluginError {
  try {
    loadOptions(raw)
  } catch (error) {
    if (error instanceof GitHubPluginError) return error
    throw error
  }
  throw new Error("expected loadOptions to throw")
}

describe("loadOptions", () => {
  it("uses the documented defaults", () => {
    for (const raw of [undefined, {}]) {
      expect(loadOptions(raw)).toEqual({
        toolsets: ["context", "repos", "issues", "pull_requests", "users", "actions", "git", "labels", "code_quality", "code_security", "secret_protection", "dependabot", "security_advisories", "discussions", "orgs"],
        readOnly: true,
        lockdown: false,
        unknownTools: "ask",
        scopes: ["repo", "read:org"],
        allowUntestedHost: false,
      })
    }
  })

  it("accepts every option", () => {
    const options = {
      toolsets: ["context", "actions", "gists"],
      readOnly: false,
      lockdown: true,
      unknownTools: "hide",
      clientId: "Ov23li.Abc_123-x",
      scopes: ["repo", "read:org", "gist"],
      allowUntestedHost: true,
    }
    expect(loadOptions(options)).toEqual(options)
  })

  it("does not share the default lists between calls", () => {
    const first = loadOptions({})
    first.toolsets.push("gists")
    expect(loadOptions({}).toolsets).toEqual(["context", "repos", "issues", "pull_requests", "users", "actions", "git", "labels", "code_quality", "code_security", "secret_protection", "dependabot", "security_advisories", "discussions", "orgs"])
  })

  it.each([
    [{ toolsets: ["context", "nope"] }, 'Invalid plugin option "toolsets.1"'],
    [{ toolsets: [] }, 'Invalid plugin option "toolsets": list at least one toolset.'],
    [{ toolsets: ["repos", "repos"] }, 'Invalid plugin option "toolsets": list each toolset once.'],
    [{ readOnly: "yes" }, 'Invalid plugin option "readOnly"'],
    [{ lockdown: 1 }, 'Invalid plugin option "lockdown"'],
    [{ unknownTools: "allow" }, 'Invalid plugin option "unknownTools"'],
    [{ clientId: "has spaces" }, `Invalid plugin option "clientId": use the OAuth App's client ID`],
    [{ clientId: "x".repeat(101) }, 'Invalid plugin option "clientId"'],
    [{ scopes: ["Repo"] }, 'Invalid plugin option "scopes.0": use a GitHub OAuth scope name such as repo or read:org.'],
    [{ scopes: ["repo", "repo"] }, 'Invalid plugin option "scopes": list each scope once.'],
    [{ allowUntestedHost: "true" }, 'Invalid plugin option "allowUntestedHost"'],
    [{ repositories: ["octo/repo"] }, 'Invalid plugin option "repositories": this option does not exist.'],
    [{ policy: {} }, 'Invalid plugin option "policy": this option does not exist.'],
  ])("names the bad key in %j", (raw, message) => {
    const error = failure(raw)
    expect(error.code).toBe("OPTIONS_INVALID")
    expect(error.message).toContain(message)
    expect(error.nextStep).toBe("Fix the options for @joe-broadhead/opencode-github in opencode.json.")
    expect(error.message.endsWith(`Next step: ${error.nextStep}`)).toBe(true)
  })

  it("rejects options that are not an object", () => {
    expect(failure("github").message).toMatch(/^OPTIONS_INVALID: Invalid plugin options: /)
  })
})

describe("host (GitHub Enterprise Server)", () => {
  it("points every endpoint at the server, and leaves github.com as the default", () => {
    expect(endpoints(loadOptions({}))).toEqual(GITHUB_COM)
    expect(endpoints(loadOptions({ host: "github.example.com" }))).toEqual({
      web: "https://github.example.com",
      api: "https://github.example.com/api/v3",
      graphql: "https://github.example.com/api/graphql",
      uploads: "https://github.example.com/api/uploads",
    })
  })

  it("offers device sign-in there only with the server's own client ID", () => {
    expect(loadOptions({ host: "github.example.com" }).clientId).toBeUndefined()
    expect(loadOptions({ host: "github.example.com", clientId: "Iv1.enterprise" }).clientId).toBe("Iv1.enterprise")
  })

  it.each([
    ["https://github.example.com", "use the server's host name"],
    ["github.com", "leave it out for github.com"],
    ["api.github.com", "leave it out for github.com"],
    ["octo.ghe.com", "GHE.com data residency is not supported yet"],
  ])("refuses %s", (host, message) => {
    expect(() => loadOptions({ host })).toThrow(`Invalid plugin option "host": ${message}`)
  })
})

describe("constants", () => {
  it("registers GitHub's hosted server under a stable name", () => {
    expect(SERVER_NAME).toBe("github")
    expect(MCP_URL).toBe("https://api.githubcopilot.com/mcp/")
  })

  it("has no default client ID, so only token sign-in is offered unless clientId is set", () => {
    expect(loadOptions({}).clientId).toBeUndefined()
    expect(loadOptions({ clientId: "Ov23liExample" }).clientId).toBe("Ov23liExample")
  })

  it("defaults to the read-only toolsets that repo and read:org cover: 47 reads once ui_get is hidden", () => {
    const reads = new Set(DEFAULT_TOOLSETS.flatMap((toolset) => KNOWN_TOOLS[toolset].read))
    for (const name of HIDDEN) reads.delete(name)
    expect(reads.size).toBe(47)
    for (const needsMoreScopes of ["projects", "gists", "notifications"]) expect(DEFAULT_TOOLSETS).not.toContain(needsMoreScopes)
  })

  it("has a tool catalog entry for every documented toolset", () => {
    expect(Object.keys(KNOWN_TOOLS).sort()).toEqual([...TOOLSETS].sort())
  })
})
