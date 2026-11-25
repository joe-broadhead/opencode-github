/**
 * The provider: GitHub's REST and GraphQL API and its activity feed, as the plugin's handlers call them.
 *
 * This directory is the only place a GitHub URL is named. An alias's credential carries its host (github.com, or a
 * GitHub Enterprise host), and every request is built from that host's endpoint set.
 */
import { callGraphql, callRest, describeCall, restTarget, type ApiInput, type ApiOutput, type CallDeps, type Fetch } from "./api.ts"
import { endpointsFor, mcpServerUrl, type Endpoints } from "./endpoints.ts"
import { EVENTS_MAX_BYTES, listEvents, probeEvents, type Get, type PageRequest, type ProbeRequest } from "./events.ts"
import type { EventsListResult, ProbeResult } from "@we-the-rebel-alliance/plugin-contract/events"

export { endpointsFor, mcpServerUrl }

/** One alias's GitHub sign-in, as the account wiring resolves it. */
export interface Credential {
  readonly token: string
  /** The GitHub login the sign-in recorded, as GET /user named it. */
  readonly login: string
  /** A GitHub Enterprise host, such as github.example.com; absent on github.com. */
  readonly host?: string | undefined
}

/** Which plugin options shape the provider's requests and its next steps. */
export interface ProviderOptions {
  /** Whether device sign-in is offered (a clientId is set), so a token problem can point to it. */
  readonly deviceSignIn: boolean
  /** The GitHub App's URL name, for the link that installs it. */
  readonly appSlug?: string | undefined
  /** The fetch a test passes; the host's global fetch unless set. */
  readonly fetch?: Fetch | undefined
}

/** What one api call answers, and whether it changed GitHub (the handler nudges apps when it did). */
export interface ApiAnswer {
  readonly output: ApiOutput
  readonly changed: boolean
}

/** The provider's three calls, each with the credential its handler resolved. */
export interface Provider {
  api(input: { readonly credential: Credential; readonly input: ApiInput; readonly root: string; readonly signal?: AbortSignal | undefined }): Promise<ApiAnswer>
  page(input: { readonly credential: Credential; readonly request: PageRequest; readonly signal?: AbortSignal | undefined }): Promise<EventsListResult>
  probe(input: { readonly credential: Credential; readonly request: ProbeRequest }): Promise<ProbeResult>
}

const serviceOf = (credential: Credential): string => (credential.host === undefined ? "GitHub" : "GitHub Enterprise")

/** The provider for the plugin's options. A test passes its own fetch, so no network is needed. */
export function createProvider(options: ProviderOptions): Provider {
  const send: Fetch = options.fetch ?? ((url, init) => fetch(url, init))

  const depsFor = (credential: Credential, input: { signal?: AbortSignal | undefined; root: string; maxReadBytes?: number; maxInlineBytes?: number }): CallDeps => ({
    token: credential.token,
    endpoints: endpointsFor(credential.host),
    service: serviceOf(credential),
    deviceSignIn: options.deviceSignIn,
    ...(options.appSlug === undefined ? {} : { appSlug: options.appSlug }),
    fetch: send,
    ...(input.signal === undefined ? {} : { signal: input.signal }),
    root: input.root,
    ...(credential.host === undefined ? {} : { enterprise: true }),
    ...(input.maxReadBytes === undefined ? {} : { maxReadBytes: input.maxReadBytes }),
    ...(input.maxInlineBytes === undefined ? {} : { maxInlineBytes: input.maxInlineBytes }),
  })

  const get = (credential: Credential, input: { signal?: AbortSignal | undefined }): Get => {
    const endpoints = endpointsFor(credential.host)
    return async (path, query, maxBytes) => {
      const deps = depsFor(credential, {
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        root: "/",
        maxReadBytes: maxBytes ?? EVENTS_MAX_BYTES,
        maxInlineBytes: maxBytes ?? EVENTS_MAX_BYTES,
      })
      return callRest({ method: "GET", path, query }, restTarget({ method: "GET", path, query }, endpoints), deps)
    }
  }

  return {
    async api(input) {
      const endpoints: Endpoints = endpointsFor(input.credential.host)
      const deps = depsFor(input.credential, { ...(input.signal === undefined ? {} : { signal: input.signal }), root: input.root })
      const described = describeCall(input.input, endpoints)
      const output = "graphql" in input.input ? await callGraphql(input.input, deps) : await callRest(input.input, restTarget(input.input, endpoints), deps)
      return { output, changed: described.kind === "write" }
    },

    async page(input) {
      return listEvents(get(input.credential, { ...(input.signal === undefined ? {} : { signal: input.signal }) }), input.request)
    },

    async probe(input) {
      const deps = depsFor(input.credential, { root: "/" })
      const probeGet: Get = async (path, query) => callRest({ method: "GET", path, query }, restTarget({ method: "GET", path, query }, deps.endpoints), deps)
      return probeEvents(probeGet, input.request)
    },
  }
}
