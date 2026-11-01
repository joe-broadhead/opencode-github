import { describe, expect, it } from "vitest"
import { graphqlKind, graphqlOperations, restKind } from "../../src/api/classify.js"

describe("restKind", () => {
  it.each([
    ["GET", "read"],
    ["HEAD", "read"],
    ["POST", "write"],
    ["PUT", "write"],
    ["PATCH", "write"],
    ["DELETE", "write"],
  ] as const)("%s is a %s", (method, kind) => {
    expect(restKind(method)).toBe(kind)
  })
})

describe("graphqlKind", () => {
  it.each([
    ["a named query", "query Viewer { viewer { login } }"],
    ["an anonymous query", "{ viewer { login } }"],
    ["a query with variables, defaults and directives", 'query Q($n: Int = 5, $f: Filter = {state: OPEN, labels: ["a"]}) @cached { repository(owner: "o", name: "r") { issues(first: $n) { nodes { title } } } }'],
    ["a query with fragments", "query { viewer { ...User } } fragment User on User { login name }"],
    ["a query whose strings and comments name a mutation", '# mutation { deleteRepository }\nquery { search(query: "mutation { x }", type: ISSUE) { issueCount } }'],
    ["a query with a block string", 'query { search(query: """\nmutation { x }\n""", type: ISSUE) { issueCount } }'],
  ])("reads %s", (_name, document) => {
    expect(graphqlKind(document)).toBe("read")
  })

  it.each([
    ["a mutation", "mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }"],
    ["a subscription", "subscription { x }"],
    ["two queries", "query A { viewer { login } } query B { viewer { name } }"],
    ["a query and a mutation", "query A { viewer { login } } mutation B { addStar(input: {}) { clientMutationId } }"],
    ["a mutation after a fragment", "fragment F on User { login } mutation { addStar(input: {}) { clientMutationId } }"],
    ["only a fragment", "fragment F on User { login }"],
    ["an empty document", "   # nothing\n"],
    ["an unterminated string", 'query { search(query: "open) { x } }'],
    ["unbalanced braces", "query { viewer { login }"],
    ["a type definition", "type Query { x: Int }"],
    ["unexpected characters", "query { viewer { login } } %"],
  ])("writes for %s", (_name, document) => {
    expect(graphqlKind(document)).toBe("write")
  })
})

describe("graphqlOperations", () => {
  it("names each operation's root fields, skipping aliases, spreads, inline fragments and directives", () => {
    expect(
      graphqlOperations(
        "mutation M { first: enablePullRequestAutoMerge(input: {a: 1}) { clientMutationId } addStar(input: {}) @skip(if: false) { x } ...F ... on Mutation { removeStar(input: {}) { x } } } fragment F on Mutation { y }",
      ),
    ).toEqual([{ type: "mutation", fields: ["enablePullRequestAutoMerge", "addStar"] }])
  })
})
