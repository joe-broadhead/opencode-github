// A deterministic fake of the GitHub endpoints the plugin calls. It answers the REST reads, the GraphQL endpoint and
// the device-flow token check, with two invented accounts. Nothing here is real: the people, repositories, issues and
// tokens are invented, and a token or account id that looks real is not.
import type { Credential } from "../../src/provider/client.ts"

/** The fixed clock every recorded answer is stamped with. */
export const NOW = Date.parse("2026-11-25T09:00:00.000Z")

/** The two invented accounts. The fake accepts these values as its bearer credentials. */
export const WORK_ACCESS = "fixture-work-access"
export const PERSONAL_ACCESS = "fixture-personal-access"

export const ACCOUNTS: Readonly<Record<string, Credential>> = {
  work: {
    get token() {
      return WORK_ACCESS
    },
    login: "ana-work",
  },
  personal: {
    get token() {
      return PERSONAL_ACCESS
    },
    login: "ana-personal",
  },
}

export interface RawIssue {
  readonly id: number
  readonly number: number
  readonly title: string
  readonly body: string
  readonly state: string
  readonly updated_at: string
  readonly html_url: string
  readonly repository_url: string
  readonly user: { readonly login: string }
  readonly labels: readonly { readonly name: string }[]
  readonly assignees: readonly { readonly login: string }[]
  readonly pull_request?: { readonly merged_at?: string }
}

interface RawCommit {
  readonly sha: string
  readonly html_url: string
  readonly repository: { readonly full_name: string }
  readonly commit: {
    readonly message: string
    readonly author: { readonly name: string; readonly email: string; readonly date: string }
    readonly committer: { readonly date: string }
  }
  readonly author: { readonly login: string }
}

interface RawNotification {
  readonly id: string
  readonly updated_at: string
  readonly reason: string
  readonly subject: { readonly type: string; readonly title: string }
  readonly repository: { readonly full_name: string; readonly html_url: string }
}

interface AccountData {
  readonly issues: readonly RawIssue[]
  readonly commits: readonly RawCommit[]
  readonly notifications: readonly RawNotification[]
}

const WORK: AccountData = {
  issues: [
    {
      id: 7001,
      number: 7,
      title: "Queue migration notes",
      body: "The queue migration is on for Thursday. The runbook is in the shared space.",
      state: "open",
      updated_at: "2026-11-20T10:00:00Z",
      html_url: "https://github.com/example/work/issues/7",
      repository_url: "https://api.github.com/repos/example/work",
      user: { login: "ana-work" },
      labels: [{ name: "ops" }],
      assignees: [],
    },
    {
      id: 8001,
      number: 8,
      title: "Retry the webhook delivery",
      body: "Adds retries and a dead-letter queue.",
      state: "closed",
      updated_at: "2026-11-21T12:00:00Z",
      html_url: "https://github.com/example/work/pull/8",
      repository_url: "https://api.github.com/repos/example/work",
      user: { login: "sam-work" },
      labels: [],
      assignees: [{ login: "ana-work" }],
      pull_request: { merged_at: "2026-11-21T12:00:00Z" },
    },
  ],
  commits: [
    {
      sha: "1a2b3c4d5e6f",
      html_url: "https://github.com/example/work/commit/1a2b3c4d5e6f",
      repository: { full_name: "example/work" },
      commit: {
        message: "Fix the queue worker\n\nThe worker now retries.",
        author: { name: "Ana Work", email: "ana@example.test", date: "2026-11-22T09:00:00Z" },
        committer: { date: "2026-11-22T09:00:00Z" },
      },
      author: { login: "ana-work" },
    },
  ],
  notifications: [
    {
      id: "101",
      updated_at: "2026-11-23T08:00:00Z",
      reason: "mention",
      subject: { type: "Discussion", title: "Design review" },
      repository: { full_name: "example/work", html_url: "https://github.com/example/work" },
    },
  ],
}

const PERSONAL: AccountData = {
  issues: [
    {
      id: 3001,
      number: 3,
      title: "Weekend reading",
      body: "A link to read later.",
      state: "open",
      updated_at: "2026-11-19T09:00:00Z",
      html_url: "https://github.com/ana/personal/issues/3",
      repository_url: "https://api.github.com/repos/ana/personal",
      user: { login: "ana-personal" },
      labels: [],
      assignees: [],
    },
  ],
  commits: [
    {
      sha: "9f8e7d6c5b4a",
      html_url: "https://github.com/ana/personal/commit/9f8e7d6c5b4a",
      repository: { full_name: "ana/personal" },
      commit: {
        message: "Tidy the notes",
        author: { name: "Ana Personal", email: "ana@example.test", date: "2026-11-18T08:00:00Z" },
        committer: { date: "2026-11-18T08:00:00Z" },
      },
      author: { login: "ana-personal" },
    },
  ],
  notifications: [
    {
      id: "202",
      updated_at: "2026-11-17T07:00:00Z",
      reason: "subscribed",
      subject: { type: "Release", title: "v1.2.0" },
      repository: { full_name: "ana/personal", html_url: "https://github.com/ana/personal" },
    },
  ],
}

const DATA: Readonly<Record<string, AccountData>> = { "ana-work": WORK, "ana-personal": PERSONAL }

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", ...headers } })
}

function number(value: string | null, fallback: number): number {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

function between(at: string, from: string | undefined, to: string | undefined): boolean {
  const time = Date.parse(at)
  return Number.isFinite(time) && (from === undefined || time >= Date.parse(from)) && (to === undefined || time <= Date.parse(to))
}

function range(query: string, key: string): { from?: string | undefined; to?: string | undefined } {
  const match = new RegExp(`${key}:(\\S+?)\\.\\.(\\S+?)(?:\\s|$)`).exec(query)
  return match ? { from: match[1], to: match[2] } : {}
}

function pageOf<T>(items: readonly T[], url: URL): { items: T[]; total: number } {
  const perPage = number(url.searchParams.get("per_page"), 30)
  const page = number(url.searchParams.get("page"), 1)
  return { items: items.slice((page - 1) * perPage, page * perPage), total: items.length }
}

/** What one fake GitHub recorded: the requests, without a token, so a test can check what was asked. */
/** What one test adds to the work account: extra issues at times it chooses. */
export interface FakeOptions {
  readonly extraWorkIssues?: readonly RawIssue[]
  /** API paths that answer 500 this time, to exercise a partial page. */
  readonly failPaths?: readonly string[]
}

export interface FakeGitHub {
  readonly fetch: (url: string, init: RequestInit) => Promise<Response>
  readonly calls: readonly string[]
  /** A login with no credential: its reads answer 401, as a revoked token does. */
  revoke(login: string): void
}

/** A fresh fake GitHub. Every instance starts empty, so a test gets the same answers every run. */
export function createFakeGitHub(options: FakeOptions = {}): FakeGitHub {
  const calls: string[] = []
  const revoked = new Set<string>()
  const data: Readonly<Record<string, AccountData>> =
    options.extraWorkIssues === undefined ? DATA : { ...DATA, "ana-work": { ...WORK, issues: [...WORK.issues, ...options.extraWorkIssues] } }

  const loginFor = (init: RequestInit): string | undefined => {
    const headers = new Headers(init.headers)
    const authorization = headers.get("authorization")
    const token = authorization?.replace(/^Bearer\s+/i, "")
    return Object.values(ACCOUNTS).find((account) => account.token === token)?.login
  }

  const fetch = async (raw: string, init: RequestInit): Promise<Response> => {
    const url = new URL(raw)
    // A GitHub Enterprise server serves the REST API under /api/v3; take that prefix off, as the host does.
    const pathname = url.pathname.replace(/^\/api\/v3(?=\/)/, "")
    const method = init.method ?? "GET"
    calls.push(`${method} ${pathname}${url.search}`)
    const login = loginFor(init)
    if (login === undefined || revoked.has(login)) return json({ message: "Bad credentials" }, 401)
    const account = data[login]
    if (account === undefined) return json({ message: "Bad credentials" }, 401)

    if (options.failPaths?.includes(pathname)) return json({ message: "Server error" }, 500)
    if (pathname === "/user") return json({ login })
    if (pathname === "/search/issues") {
      const query = url.searchParams.get("q") ?? ""
      const pullRequest = query.includes("is:pull-request")
      const issues = account.issues
        .filter((issue) => (issue.pull_request !== undefined) === pullRequest)
        .filter((issue) => between(issue.updated_at, range(query, "updated").from, range(query, "updated").to))
        .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
      const page = pageOf(issues, url)
      return json({ total_count: page.total, incomplete_results: false, items: page.items })
    }
    if (pathname === "/search/commits") {
      const query = url.searchParams.get("q") ?? ""
      const commits = account.commits
        .filter((commit) => between(commit.commit.committer.date, range(query, "committer-date").from, range(query, "committer-date").to))
        .sort((left, right) => left.commit.committer.date.localeCompare(right.commit.committer.date))
      const page = pageOf(commits, url)
      return json({ total_count: page.total, incomplete_results: false, items: page.items })
    }
    if (pathname === "/notifications") {
      const since = url.searchParams.get("since")
      const before = url.searchParams.get("before")
      const notifications = account.notifications
        .filter((notification) => between(notification.updated_at, since ?? undefined, before ?? undefined))
        .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      return json(pageOf(notifications, url).items)
    }
    if (pathname === "/repos/example/work" && method === "GET") return json({ full_name: "example/work", default_branch: "main" })
    if (pathname === "/repos/example/work/issues" && method === "GET") {
      const perPage = number(url.searchParams.get("per_page"), 30)
      const page = number(url.searchParams.get("page"), 1)
      const items = account.issues.slice((page - 1) * perPage, page * perPage)
      const next = page * perPage < account.issues.length ? { link: `<https://api.github.com/repos/example/work/issues?per_page=${perPage}&page=${page + 1}>; rel="next"` } : {}
      return json(items, 200, next)
    }
    if (pathname === "/repos/example/work/issues" && method === "POST") {
      return json({ number: 9, title: "Created by a test" }, 201)
    }
    if (pathname === "/repos/example/work/releases/assets/1" && method === "GET") {
      return new Response("fixture bytes", { status: 200, headers: { "content-type": "application/octet-stream" } })
    }
    if (pathname === "/graphql" && method === "POST") {
      const body = JSON.parse(String(init.body)) as { query?: string }
      const read = typeof body.query === "string" && /^\s*(?:query\b|\{)/.test(body.query)
      return json(read ? { data: { viewer: { login } } } : { data: { addStar: { clientMutationId: null } } })
    }
    return json({ message: "Not Found" }, 404)
  }

  return {
    fetch,
    calls,
    revoke(login: string) {
      revoked.add(login)
    },
  }
}
