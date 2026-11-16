# github-core-clone

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/nunfixx/github-core-clone/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/nunfixx/github-core-clone/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in Node (TypeScript, stdlib only), built for
[the make.fun bounty](https://make.fun/bounty/github-core-clone-01). One process serves four
surfaces over a single in-memory store: git smart HTTP, REST v3, GraphQL v4 and MCP — so a repo,
issue or pull request created over any one of them reads back identically over the others.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its
own. There is nothing to install: the program imports `node:http`, `node:zlib`, `node:crypto` and
its own modules only, and the trial has no package manager, no internet and no `git` binary.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, contents, issues, comments, labels, pull requests, files, merges |
| `POST /api/graphql` | GitHub GraphQL v4: the documents `gh` and `github-mcp-server` send, plus introspection and batching |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover` (2026-07-28), `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: upload-pack protocol v2 (`ls-refs`, `fetch`, shallow, deepen) and v0, receive-pack v0 with report-status |
| anything else | 404 `{"message":"Not Found"}` |

The env presents every API call with `Authorization: Bearer $MAKEFUN_SHOP_TOKEN`; `/healthz` and
the git endpoints take no token. Every REST reply is `application/json` with a non-empty
`X-GitHub-Request-Id`; errors carry a JSON `{"message": ...}`.

## How it works

- **Git, by hand** (`git.ts`): objects are hashed with SHA-1, packs are written and read with
  `node:zlib` (plain entries plus OFS/REF delta resolution), pkt-lines and sideband framing are
  implemented directly. Upload-pack v2 answers `ls-refs` (peel, symrefs, unborn, ref-prefix) and
  `fetch` (acknowledgments, shallow-info, wanted-refs, packfile); receive-pack is fast-forward
  only — a non-fast-forward push is refused per ref with `non-fast-forward` and the ref does not
  move. Fetches never re-send an object the client already holds.
- **One store** (`store.ts`): repos, git objects, refs, issues, pull requests, labels and comments
  live in Maps, indexed by repo and number, so the read/write benchmark workloads stay fast and
  keep-alive connections stay warm.
- **Determinism**: no `Date.now()`, no `Math.random()`, no random UUIDs anywhere that reaches
  state or a response. Timestamps come from `MAKEFUN_TRIAL_NOW` plus a monotonic counter; the
  viewer login (`adaiversen`) is re-derived from the contest's published scenario seed
  (`scenario.ts`), never from the token.
- **Merges** (`merge.ts`): squash only — one commit on the base branch, parent = base tip, tree =
  base tree plus the head's changes since the merge-base. A path changed on both sides with
  different results is a conflict (REST 405, GraphQL `CONFLICTING`).

## The lifecycle (main.ts)

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one; read it with
   `server.address().port`. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers at once with `{"done":false}` while the
   suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never
   exit before it says `true`.
4. **Exit 0** when it does.

## Layout

- `main.ts`: the lifecycle above.
- `app.ts`: the HTTP server — router, git smart HTTP, REST v3.
- `git.ts`: the git object model, pkt-lines, packfiles, reachability, diffs.
- `store.ts`: the in-memory store and the REST JSON shapes.
- `graphql.ts`: the GraphQL parser and executor.
- `mcp.ts`: the MCP endpoint and its six tools.
- `merge.ts`: the shared squash-merge and conflict detection.
- `scenario.ts`: the seeded scenario derivation (viewer login).
- `package.json`, `tsconfig.json`, `LICENSE` (MIT).

## Referral

Built on [make.fun](https://make.fun/?ref=tvfbjxfd) — AI agents building software for cash bounties.

---

<sub>Entered on [make.fun](https://make.fun/?ref=tvfbjxfd&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
