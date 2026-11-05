// Read or write, for github_api. REST: GET and HEAD read, and so do the POST endpoints in
// POST_READS, which only render text; every other request writes.
// GraphQL: a document reads only when it holds exactly one operation and that operation
// is a query. Anything else, including a document this scanner cannot follow, writes, so
// it asks first.

export type Kind = "read" | "write"

/** POST endpoints that change nothing: GitHub renders the Markdown it is sent. Exact paths only. */
const POST_READS: readonly string[] = ["/markdown", "/markdown/raw"]

/** `path` is the canonical path restTarget sends, without the query. */
export function restKind(method: string, path: string): Kind {
  if (method === "GET" || method === "HEAD") return "read"
  return method === "POST" && POST_READS.includes(path) ? "read" : "write"
}

export type GraphqlOperation = { readonly type: "query" | "mutation" | "subscription"; readonly fields: readonly string[] }

/**
 * The operations of an executable GraphQL document, with the root field names of each, or
 * undefined when the document cannot be read. A lexical scan, not a full parser: it skips
 * comments, strings (block strings too), commas and whitespace, and follows brackets, so
 * keywords inside strings, arguments or selections never count.
 */
export function graphqlOperations(document: string): GraphqlOperation[] | undefined {
  const tokens = tokenize(document)
  if (!tokens) return undefined
  const operations: GraphqlOperation[] = []
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    let type: GraphqlOperation["type"] | "fragment"
    if (token === "{") type = "query"
    else if (token === "query" || token === "mutation" || token === "subscription" || token === "fragment") {
      type = token
      index++
    } else return undefined
    // The header (name, variables, directives, type condition) runs to the selection set.
    let depth = 0
    while (index < tokens.length && !(depth === 0 && tokens[index] === "{")) {
      const next = tokens[index]!
      if (next === "(" || next === "[") depth++
      else if (next === ")" || next === "]") depth--
      else if (next === "{" || next === "}") {
        // Object values in variable defaults sit inside parentheses.
        if (depth === 0) return undefined
      }
      if (depth < 0) return undefined
      index++
    }
    if (tokens[index] !== "{") return undefined
    const selection = readSelection(tokens, index)
    if (!selection) return undefined
    index = selection.end
    if (type !== "fragment") operations.push({ type, fields: selection.fields })
  }
  return operations
}

export function graphqlKind(document: string): Kind {
  const operations = graphqlOperations(document)
  return operations?.length === 1 && operations[0]!.type === "query" ? "read" : "write"
}

/** The selection set starting at `start` (a "{"): its end index and its top-level field names. */
function readSelection(tokens: readonly string[], start: number): { end: number; fields: string[] } | undefined {
  const fields: string[] = []
  let braces = 0
  let parens = 0
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index]!
    if (token === "(") parens++
    else if (token === ")") parens--
    else if (token === "{") braces++
    else if (token === "}") {
      braces--
      if (braces === 0 && parens === 0) return { end: index + 1, fields }
    } else if (braces === 1 && parens === 0 && isRootField(tokens, index)) fields.push(token)
    if (braces < 0 || parens < 0) return undefined
  }
  return undefined
}

/** A name in a top-level selection that is a field: not an alias, a fragment spread, a type condition or a directive. */
function isRootField(tokens: readonly string[], index: number): boolean {
  if (!/^[_A-Za-z]/.test(tokens[index]!)) return false
  const previous = tokens[index - 1]
  if (previous === "..." || previous === "@" || previous === "$") return false
  if (previous === "on" && tokens[index - 2] === "...") return false
  return tokens[index + 1] !== ":"
}

/** Punctuators and names; strings, numbers, comments and commas are dropped. Undefined on an unterminated string. */
function tokenize(document: string): string[] | undefined {
  const tokens: string[] = []
  let index = 0
  while (index < document.length) {
    const char = document[index]!
    if (char === "#") {
      while (index < document.length && document[index] !== "\n" && document[index] !== "\r") index++
    } else if (/[\s,﻿]/.test(char)) {
      index++
    } else if (document.startsWith('"""', index)) {
      const end = blockStringEnd(document, index + 3)
      if (end === -1) return undefined
      index = end
    } else if (char === '"') {
      const end = stringEnd(document, index + 1)
      if (end === -1) return undefined
      index = end
    } else if (document.startsWith("...", index)) {
      tokens.push("...")
      index += 3
    } else if ("{}()[]:=@!$&|".includes(char)) {
      tokens.push(char)
      index++
    } else if (/[_A-Za-z]/.test(char)) {
      const match = /^[_A-Za-z][_0-9A-Za-z]*/.exec(document.slice(index))!
      tokens.push(match[0])
      index += match[0].length
    } else if (/[-0-9]/.test(char)) {
      const match = /^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?/.exec(document.slice(index))
      if (!match) return undefined
      index += match[0].length
    } else {
      return undefined
    }
  }
  return tokens
}

function stringEnd(document: string, from: number): number {
  for (let index = from; index < document.length; index++) {
    const char = document[index]
    if (char === "\\") index++
    else if (char === '"') return index + 1
    else if (char === "\n" || char === "\r") return -1
  }
  return -1
}

function blockStringEnd(document: string, from: number): number {
  for (let index = from; index < document.length; index++) {
    if (document.startsWith('\\"""', index)) index += 3
    else if (document.startsWith('"""', index)) return index + 3
  }
  return -1
}
