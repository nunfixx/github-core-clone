// app.ts — the forge's HTTP server: git smart HTTP, REST v3, GraphQL v4 and MCP, all over one
// in-memory Store. Every /api/v3 reply is application/json with a non-empty X-GitHub-Request-Id;
// errors carry a JSON {message}; an unknown route is a JSON 404; a malformed JSON body is a 400.
// Auth: Bearer MAKEFUN_SHOP_TOKEN on /api/v3, /api/graphql and /mcp (no token = 401). Git smart
// HTTP and /healthz take no token, as the suite's git client sends none.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store, commentJson, issueJson, pullJson, repoJson, type Repo } from './store.ts';
import { DEFAULT_BRANCH, ZERO_OID, viewerUser } from './scenario.ts';
import {
  PKT_DELIM,
  PKT_FLUSH,
  buildCommit,
  buildTreeFromEntries,
  collectTree,
  diffTrees,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  parseTag,
  parseTree,
  pktLine,
  pktTextLines,
  putObject,
  reachableCommits,
  readPack,
  sidebandPack,
  writePack,
  type GitObject,
} from './git.ts';
import { executeGraphQLBatch } from './graphql.ts';
import { handleMcpRequest, mcpParseError } from './mcp.ts';
import { computeMergeable, isFastForward, squashMerge } from './merge.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
const AGENT = 'github-core-clone/1.0';

const envToken = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Parse the request URL once: path and query come from the same URL object (the old code
 *  constructed a new URL for each of them). On an unparsable URL the path is '/' and the query
 *  is empty, as before. */
function requestUrl(req: IncomingMessage): { path: string; query: URLSearchParams } {
  try {
    const url = new URL(req.url ?? '/', 'http://entry');
    return { path: url.pathname, query: url.searchParams };
  } catch {
    return { path: '/', query: new URLSearchParams() };
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Read a request body fully (up to 64 MiB). */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 64 * 1024 * 1024) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, store: Store, status: number, body: unknown, headers: Readonly<Record<string, string>> = {}): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': store.nextRequestId(),
    ...headers,
  });
  res.end(text);
}

function sendBytes(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function jsonError(res: ServerResponse, store: Store, status: number, message: string): void {
  sendJson(res, store, status, { message });
}

/** The bearer token authorizes; an empty env token means "any non-empty bearer". */
function authorized(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (token === '') return false;
  if (envToken === '') return true;
  return token === envToken;
}

// ---------------------------------------------------------------- git helpers

interface RefLine {
  readonly oid: string;
  readonly name: string;
  readonly peeled?: string;
  readonly unborn?: boolean;
  readonly symrefTarget?: string;
}

/** All refs of a repo, sorted, with HEAD first: the v0 advertisement order. */
function advertisedRefs(repo: Repo): RefLine[] {
  const lines: RefLine[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  lines.push({
    oid: defaultTip ?? ZERO_OID,
    name: 'HEAD',
    unborn: defaultTip === undefined,
    symrefTarget: defaultRef,
  });
  const names = [...repo.refs.keys()].sort();
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    const object = repo.objects.get(oid);
    let peeled: string | undefined;
    if (object !== undefined && object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.type === 'commit') peeled = tag.object;
    }
    lines.push({ oid, name, peeled });
  }
  return lines;
}

function v0Capabilities(service: string): string {
  if (service === 'git-upload-pack') {
    return `side-band-64k thin-pack ofs-delta shallow multi_ack symref=HEAD:refs/heads/${DEFAULT_BRANCH} agent=${AGENT}`;
  }
  return `report-status side-band-64k delete-refs agent=${AGENT}`;
}

/** The v0 advertisement body for a service, with the # service= preamble. */
function v0Advertisement(repo: Repo, service: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const caps = v0Capabilities(service);
  const refs = advertisedRefs(repo);
  if (refs.length === 1 && refs[0]?.name === 'HEAD' && refs[0]?.unborn === true) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    refs.forEach((ref, index) => {
      let line = `${ref.oid} ${ref.name}`;
      if (index === 0) line += `\0${caps}`;
      line += '\n';
      parts.push(pktLine(line));
      if (ref.peeled !== undefined) parts.push(pktLine(`${ref.peeled} ${ref.name}^{}\n`));
    });
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement: `version 2` then capability lines, then flush. */
function v2Advertisement(): Buffer {
  return Buffer.concat([
    pktLine('version 2\n'),
    pktLine('ls-refs=unborn\n'),
    pktLine('fetch=shallow wait-for-done\n'),
    pktLine('object-format=sha1\n'),
    pktLine(`agent=${AGENT}\n`),
    PKT_FLUSH,
  ]);
}

function handleAdvertisement(store: Store, repo: Repo, service: string, req: IncomingMessage, res: ServerResponse): void {
  const contentType = service === 'git-upload-pack' ? 'application/x-git-upload-pack-advertisement' : 'application/x-git-receive-pack-advertisement';
  if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2') {
    sendBytes(res, 200, v2Advertisement(), contentType);
    return;
  }
  sendBytes(res, 200, v0Advertisement(repo, service), contentType);
}

/** ls-refs lines for the v2 command, filtered by ref-prefixes. */
function lsRefsLines(repo: Repo, prefixes: string[], wantPeel: boolean, wantSymrefs: boolean, wantUnborn: boolean): Buffer {
  const parts: Buffer[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const defaultTip = repo.refs.get(defaultRef);
  if (keep('HEAD')) {
    if (defaultTip === undefined) {
      if (wantUnborn) parts.push(pktLine(`unborn HEAD${wantSymrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    } else {
      parts.push(pktLine(`${defaultTip} HEAD${wantSymrefs ? ` symref-target:${defaultRef}` : ''}\n`));
    }
  }
  for (const name of [...repo.refs.keys()].sort()) {
    if (!keep(name)) continue;
    const oid = repo.refs.get(name) as string;
    let line = `${oid} ${name}`;
    const object = repo.objects.get(oid);
    if (wantPeel && object !== undefined && object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.type === 'commit') line += ` peeled:${tag.object}`;
    }
    parts.push(pktLine(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface FetchPlan {
  readonly objects: Map<string, GitObject>;
  readonly shallow: string[];
  readonly unshallow: string[];
}

/**
 * Which objects a fetch sends. Wants resolve to commits (tags peel to their commit, the tag object
 * itself included); haves, the client's shallow boundaries and deepen-not refs are excluded with
 * everything reachable from them; depth / deepen-since cut the walk; the shallow-info names the
 * new cut boundary and the old boundaries that are now included.
 */
function planFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  clientShallow: readonly string[],
  depth: number | undefined,
  deepenSince: number | undefined,
  deepenNot: readonly string[],
): FetchPlan {
  const objects = repo.objects;
  // Resolve wants to commits, remembering tag objects to include.
  const wantCommits: string[] = [];
  const tagObjects = new Map<string, GitObject>();
  for (const want of wants) {
    const object = objects.get(want);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      tagObjects.set(want, object);
      const tag = parseTag(object.data);
      if (tag.type === 'commit') wantCommits.push(tag.object);
      continue;
    }
    if (object.type === 'commit') wantCommits.push(want);
  }
  // Everything already held: haves, the client's shallow boundaries and deepen-not refs. A
  // shallow boundary is held, but its parents are not: the walk from a have stops there, so a
  // deepen can still deliver the generations behind the boundary.
  const excludedCommits = new Set<string>();
  const excludedObjects = new Map<string, GitObject>();
  const shallowSet = new Set(clientShallow);
  const heldQueue: string[] = [];
  const pushHeld = (oid: string): void => {
    const object = objects.get(oid);
    if (object === undefined) return;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.type === 'commit') pushHeld(tag.object);
      return;
    }
    if (object.type !== 'commit') return;
    if (!excludedCommits.has(oid)) {
      excludedCommits.add(oid);
      heldQueue.push(oid);
    }
  };
  for (const have of haves) pushHeld(have);
  for (const boundary of clientShallow) pushHeld(boundary);
  for (const ref of deepenNot) {
    const tip = repo.refs.get(ref) ?? repo.refs.get(`refs/heads/${ref}`);
    if (tip !== undefined) pushHeld(tip);
  }
  while (heldQueue.length > 0) {
    const oid = heldQueue.shift() as string;
    if (shallowSet.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) pushHeld(parent);
  }
  for (const oid of excludedCommits) {
    const object = objects.get(oid);
    if (object === undefined) continue;
    excludedObjects.set(oid, object);
    if (object.type === 'commit') collectTree(objects, parseCommit(object.data).tree, excludedObjects);
  }
  // Walk from the wants with the depth / deepen-since cut. The walk passes through held commits
  // (a deepen behind a shallow boundary needs the generations behind it); what is SENT is the
  // included set minus the held set, decided below.
  const included = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const tip of wantCommits) {
    if (!included.has(tip)) {
      included.set(tip, 0);
      queue.push({ oid: tip, generation: 0 });
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; generation: number };
    if (depth !== undefined && current.generation + 1 >= depth) continue;
    const object = objects.get(current.oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    if (deepenSince !== undefined) {
      const stamp = commitTimestamp(commit.committer);
      if (stamp !== null && stamp < deepenSince) continue;
    }
    for (const parent of commit.parents) {
      if (included.has(parent)) continue;
      included.set(parent, current.generation + 1);
      queue.push({ oid: parent, generation: current.generation + 1 });
    }
  }
  // The objects to send: included commits + their trees/blobs + tag objects, minus held objects.
  const send = new Map<string, GitObject>();
  for (const oid of included.keys()) {
    if (excludedCommits.has(oid)) continue;
    const object = objects.get(oid);
    if (object === undefined) continue;
    send.set(oid, object);
    if (object.type === 'commit') collectTree(objects, parseCommit(object.data).tree, send);
  }
  for (const [oid, object] of tagObjects) send.set(oid, object);
  for (const oid of excludedObjects.keys()) send.delete(oid);
  // Shallow-info: included commits whose parent is neither included nor excluded (a depth cut);
  // unshallow: client boundaries that are now included.
  const shallow: string[] = [];
  if (depth !== undefined || deepenSince !== undefined) {
    for (const oid of included.keys()) {
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') continue;
      const commit = parseCommit(object.data);
      if (commit.parents.length === 0) {
        // A root commit at the cut is a boundary only when the walk stopped for depth.
        if (depth !== undefined && (included.get(oid) as number) === depth - 1) shallow.push(oid);
        continue;
      }
      const cut = commit.parents.some((parent) => !included.has(parent) && !excludedCommits.has(parent));
      if (cut) shallow.push(oid);
    }
  }
  const unshallow = clientShallow.filter((boundary) => included.has(boundary));
  shallow.sort();
  unshallow.sort();
  return { objects: send, shallow, unshallow };
}

function commitTimestamp(identity: string): number | null {
  const match = / (\d+) [+-]\d{4}$/.exec(identity);
  if (match === null) return null;
  return Number.parseInt(match[1] as string, 10);
}

function handleUploadPackV2(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  const lines = pktTextLines(body);
  const command = lines[0] ?? '';
  if (command === 'command=ls-refs') {
    let peel = false;
    let symrefs = false;
    let unborn = false;
    const prefixes: string[] = [];
    for (const line of lines.slice(1)) {
      if (line === 'peel') peel = true;
      else if (line === 'symrefs') symrefs = true;
      else if (line === 'unborn') unborn = true;
      else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice('ref-prefix '.length));
    }
    sendBytes(res, 200, lsRefsLines(repo, prefixes, peel, symrefs, unborn), 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'command=fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    const deepenNot: string[] = [];
    let depth: number | undefined;
    let deepenSince: number | undefined;
    for (const line of lines.slice(1)) {
      if (line.startsWith('want ')) wants.push(line.slice(5).trim());
      else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
      else if (line.startsWith('deepen-since ')) deepenSince = Number.parseInt(line.slice(13), 10);
      else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
    }
    const plan = planFetch(repo, wants, haves, shallow, depth, deepenSince, deepenNot);
    // Sections are omitted when empty, as real git servers do over stateless HTTP: no
    // acknowledgments section (negotiation is single-round here), no wanted-refs, and
    // shallow-info only when it names a boundary. The packfile section is omitted too when
    // there is nothing to send; the response then ends with a bare flush.
    const parts: Buffer[] = [];
    if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
      for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
      parts.push(PKT_DELIM);
    }
    if (plan.objects.size > 0) {
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(writePack(plan.objects)));
      parts.push(PKT_FLUSH);
    } else {
      parts.push(PKT_FLUSH);
    }
    sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  sendBytes(res, 200, PKT_FLUSH, 'application/x-git-upload-pack-result');
}

function handleUploadPackV0(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  const lines = pktTextLines(body);
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  const deepenNot: string[] = [];
  let depth: number | undefined;
  let deepenSince: number | undefined;
  for (const line of lines) {
    if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0] as string);
    else if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
    else if (line.startsWith('deepen ')) depth = Number.parseInt(line.slice(7), 10);
    else if (line.startsWith('deepen-since ')) deepenSince = Number.parseInt(line.slice(13), 10);
    else if (line.startsWith('deepen-not ')) deepenNot.push(line.slice(11).trim());
  }
  const plan = planFetch(repo, wants, haves, shallow, depth, deepenSince, deepenNot);
  const parts: Buffer[] = [];
  const knownHaves = haves.filter((have) => repo.objects.has(have));
  if (knownHaves.length > 0) {
    for (const have of knownHaves) parts.push(pktLine(`ACK ${have}\n`));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  if (plan.objects.size > 0) parts.push(sidebandPack(writePack(plan.objects)));
  parts.push(PKT_FLUSH);
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

interface PushCommand {
  readonly oldOid: string;
  readonly newOid: string;
  readonly ref: string;
}

function handleReceivePack(store: Store, repo: Repo, body: Buffer, res: ServerResponse): void {
  // Command pkt-lines up to the first flush; everything after is the pack.
  const packets = parsePktLinesLocal(body);
  const commands: PushCommand[] = [];
  let packStart = body.length;
  for (let i = 0; i < packets.length; i += 1) {
    const packet = packets[i] as { kind: string; payload: Buffer; end: number };
    if (packet.kind === 'flush') {
      packStart = packet.end;
      break;
    }
    if (packet.kind !== 'data') continue;
    const text = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = text.indexOf('\0');
    const commandText = nul >= 0 ? text.slice(0, nul) : text;
    const parts = commandText.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
  }
  const packBytes = body.subarray(packStart);
  let unpackOk = true;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch {
      unpackOk = false;
    }
  }
  const reportLines: string[] = [];
  if (unpackOk) reportLines.push('unpack ok\n');
  else reportLines.push('unpack error\n');
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed\n`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      } else {
        repo.refs.delete(command.ref);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (repo.objects.get(command.newOid) === undefined) {
      reportLines.push(`ng ${command.ref} object not found\n`);
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        reportLines.push(`ng ${command.ref} already exists\n`);
      } else {
        repo.refs.set(command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}\n`);
      }
      continue;
    }
    if (current === undefined) {
      reportLines.push(`ng ${command.ref} remote ref does not exist\n`);
      continue;
    }
    if (current !== command.oldOid) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    if (!isFastForward(repo, command.oldOid, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}\n`);
  }
  // With side-band-64k the report-status stream is itself pkt-lined inside band 1: the outer
  // pkt-line carries band byte 0x01, the inner stream is pktLine("unpack ok") + pktLine("ok ...")
  // + ... + flush, and the response ends with an outer flush.
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  const parts: Buffer[] = [sidebandPack(inner), PKT_FLUSH];
  sendBytes(res, 200, Buffer.concat(parts), 'application/x-git-receive-pack-result');
}

/** parsePktLines with the end offset of each packet, for splitting commands from the pack. */
function parsePktLinesLocal(buffer: Buffer): Array<{ kind: string; payload: Buffer; end: number }> {
  const packets: Array<{ kind: string; payload: Buffer; end: number }> = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const length = parseInt(buffer.subarray(offset, offset + 4).toString('utf8'), 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0), end: offset + 4 });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)), end: offset + length });
    offset += length;
  }
  return packets;
}

// ---------------------------------------------------------------- REST helpers

function viewerLogin(): string {
  return viewerUser().login;
}

/** The repo at /repos/{owner}/{name}, or null (a repo under another owner is a 404, never a 403). */
function restRepo(store: Store, owner: string, name: string): Repo | null {
  if (owner !== viewerLogin()) return null;
  return store.getRepo(owner, name) ?? null;
}

function branchTip(repo: Repo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

function identityParts(identity: string): { name: string; email: string; date: string } {
  const match = /^([^<]*) <([^>]*)> (\d+) ([+-]\d{4})$/.exec(identity);
  if (match === null) return { name: identity, email: '', date: '' };
  return {
    name: (match[1] as string).trim(),
    email: match[2] as string,
    date: new Date(Number.parseInt(match[3] as string, 10) * 1000).toISOString(),
  };
}

function commitJson(repo: Repo, sha: string): Record<string, unknown> | null {
  const object = repo.objects.get(sha);
  if (object === undefined || object.type !== 'commit') return null;
  const commit = parseCommit(object.data);
  const author = identityParts(commit.author);
  const committer = identityParts(commit.committer);
  return {
    sha,
    commit: {
      // The stored message ends with one newline; the API returns it without.
      message: commit.message.replace(/\n$/, ''),
      author: { name: author.name, email: author.email, date: author.date },
      committer: { name: committer.name, email: committer.email, date: committer.date },
      tree: { sha: commit.tree },
    },
    parents: commit.parents.map((parent) => ({ sha: parent })),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/commits/${sha}`,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/commit/${sha}`,
  };
}

/** First-parent walk from `tip`, newest first. */
function commitList(repo: Repo, tip: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  let current: string | undefined = tip;
  const seen = new Set<string>();
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    const json = commitJson(repo, current);
    if (json === null) break;
    out.push(json);
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'commit') break;
    current = parseCommit(object.data).parents[0];
  }
  return out;
}

function lineCounts(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (object === undefined) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function lineDiffCounts(repo: Repo, oldOid: string, newOid: string): { additions: number; deletions: number } {
  const oldObject = repo.objects.get(oldOid);
  const newObject = repo.objects.get(newOid);
  if (oldObject === undefined || newObject === undefined) return { additions: 0, deletions: 0 };
  const oldLines = oldObject.data.toString('utf8').split('\n');
  const newLines = newObject.data.toString('utf8').split('\n');
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  const newCounts = new Map<string, number>();
  for (const line of newLines) newCounts.set(line, (newCounts.get(line) ?? 0) + 1);
  let additions = 0;
  let deletions = 0;
  for (const [line, count] of newCounts) {
    const oldCount = oldCounts.get(line) ?? 0;
    if (count > oldCount) additions += count - oldCount;
  }
  for (const [line, count] of oldCounts) {
    const newCount = newCounts.get(line) ?? 0;
    if (count > newCount) deletions += count - newCount;
  }
  return { additions, deletions };
}

/** Write one contents change as a real git commit; returns the commit oid. */
function contentsCommit(
  store: Store,
  repo: Repo,
  branch: string,
  path: string,
  content: Buffer | null,
  message: string,
): { commitSha: string; blobSha: string | null; created: boolean } {
  let tip = branchTip(repo, branch);
  if (tip === undefined) {
    // A branch that does not exist yet starts from the default tip (or from nothing).
    const defaultTip = branchTip(repo, repo.defaultBranch);
    if (defaultTip !== undefined) {
      repo.refs.set(`refs/heads/${branch}`, defaultTip);
      tip = defaultTip;
    }
  }
  const treeOid = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const entries = treeOid === null ? new Map<string, { mode: string; oid: string }>() : flattenTree(repo.objects, treeOid);
  const created = !entries.has(path);
  let blobSha: string | null = null;
  if (content !== null) {
    blobSha = putObject(repo.objects, 'blob', content);
    entries.set(path, { mode: '100644', oid: blobSha });
  } else {
    entries.delete(path);
  }
  const newTree = buildTreeFromEntries(repo.objects, entries);
  const viewer = viewerUser();
  const stamp = store.nowSec();
  const identity = `${viewer.name} <${viewer.email}> ${stamp} +0000`;
  const commit = buildCommit({
    tree: newTree,
    parents: tip === undefined ? [] : [tip],
    author: identity,
    committer: identity,
    message: `${message}\n`,
  });
  const commitSha = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${branch}`, commitSha);
  return { commitSha, blobSha, created };
}

/** The tree oid at a path inside a root tree, or null when the path is not a tree. */
function subtreeOid(repo: Repo, rootTree: string, path: string): string | null {
  if (path === '') return rootTree;
  let current = rootTree;
  for (const segment of path.split('/')) {
    const object = repo.objects.get(current);
    if (object === undefined || object.type !== 'tree') return null;
    const entry = parseTree(object.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

function paginate<T>(items: readonly T[], page: number, perPage: number): { page: T[]; totalPages: number } {
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const start = (page - 1) * perPage;
  return { page: items.slice(start, start + perPage), totalPages };
}

function linkHeader(req: IncomingMessage, path: string, query: URLSearchParams, page: number, totalPages: number): string {
  const host = req.headers.host ?? '127.0.0.1';
  const base = `http://${host}${path}`;
  const links: string[] = [];
  const make = (pageNumber: number, rel: string): string => {
    const params = new URLSearchParams(query);
    params.set('page', String(pageNumber));
    return `<${base}?${params.toString()}>; rel="${rel}"`;
  };
  if (page < totalPages) links.push(make(page + 1, 'next'));
  if (page > 1) links.push(make(page - 1, 'prev'));
  links.push(make(1, 'first'));
  links.push(make(totalPages, 'last'));
  return links.join(', ');
}

// ---------------------------------------------------------------- REST router

async function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  body: Buffer,
): Promise<void> {
  const method = req.method ?? 'GET';
  const parseBody = (): Record<string, unknown> => {
    if (body.length === 0) return {};
    let parsed: unknown;
    try {
      parsed = JSON.parse(body.toString('utf8'));
    } catch {
      throw new Error('malformed JSON body');
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('malformed JSON body');
    return parsed as Record<string, unknown>;
  };

  // GET /api/v3 — the API root, with the token's scopes.
  if (segments.length === 0 && method === 'GET') {
    sendJson(res, store, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return;
  }
  // GET /api/v3/meta
  if (segments.length === 1 && segments[0] === 'meta' && method === 'GET') {
    sendJson(res, store, 200, { installed_version: '1.0.0' });
    return;
  }
  // GET /api/v3/user
  if (segments.length === 1 && segments[0] === 'user' && method === 'GET') {
    const viewer = viewerUser();
    sendJson(res, store, 200, { login: viewer.login, id: viewer.id, name: viewer.name, email: viewer.email, type: 'User' });
    return;
  }
  // /api/v3/user/repos
  if (segments.length === 2 && segments[0] === 'user' && segments[1] === 'repos') {
    if (method === 'GET') {
      const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
      const perPage = Math.max(1, Number.parseInt(query.get('per_page') ?? '30', 10) || 30);
      const repos = store.viewerRepos();
      const { page: pageItems, totalPages } = paginate(repos, page, perPage);
      const headers: Record<string, string> = {};
      if (totalPages > 1) headers.link = linkHeader(req, '/api/v3/user/repos', query, page, totalPages);
      sendJson(res, store, 200, pageItems.map((repo) => repoJson(repo)), headers);
      return;
    }
    if (method === 'POST') {
      let input: Record<string, unknown>;
      try {
        input = parseBody();
      } catch {
        jsonError(res, store, 400, 'Problems parsing JSON');
        return;
      }
      const name = typeof input.name === 'string' ? input.name : '';
      if (name === '') {
        jsonError(res, store, 422, 'name is required');
        return;
      }
      const repo = store.createRepo(viewerLogin(), name, typeof input.description === 'string' ? input.description : '', input.private === true);
      if (repo === null) {
        jsonError(res, store, 422, `Repository ${viewerLogin()}/${name} already exists`);
        return;
      }
      sendJson(res, store, 201, repoJson(repo));
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }

  // /api/v3/repos/{owner}/{name}/...
  if (segments.length >= 3 && segments[0] === 'repos') {
    const owner = decodeSegment(segments[1] as string);
    const name = decodeSegment(segments[2] as string);
    const rest = segments.slice(3);
    const repo = restRepo(store, owner, name);
    if (repo === null) {
      jsonError(res, store, 404, 'Not Found');
      return;
    }

    // GET /repos/{o}/{r} | PATCH | DELETE
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, store, 200, repoJson(repo));
        return;
      }
      if (method === 'PATCH') {
        let input: Record<string, unknown>;
        try {
          input = parseBody();
        } catch {
          jsonError(res, store, 400, 'Problems parsing JSON');
          return;
        }
        if (typeof input.description === 'string') repo.description = input.description;
        if (typeof input.private === 'boolean') repo.isPrivate = input.private;
        repo.updatedAt = store.nowIso();
        sendJson(res, store, 200, repoJson(repo));
        return;
      }
      if (method === 'DELETE') {
        store.deleteRepo(owner, name);
        res.writeHead(204);
        res.end();
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }

    // POST /repos/{o}/{r}/git/refs
    if (rest.length === 2 && rest[0] === 'git' && rest[1] === 'refs' && method === 'POST') {
      let input: Record<string, unknown>;
      try {
        input = parseBody();
      } catch {
        jsonError(res, store, 400, 'Problems parsing JSON');
        return;
      }
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (ref === '' || sha === '') {
        jsonError(res, store, 422, 'ref and sha are required');
        return;
      }
      if (repo.objects.get(sha) === undefined) {
        jsonError(res, store, 422, `Object ${sha} does not exist`);
        return;
      }
      if (repo.refs.has(ref)) {
        jsonError(res, store, 422, `Reference ${ref} already exists`);
        return;
      }
      repo.refs.set(ref, sha);
      sendJson(res, store, 201, { ref, object: { sha }, url: `/api/v3/repos/${owner}/${name}/git/refs/${encodeURIComponent(ref)}` });
      return;
    }
    // GET /repos/{o}/{r}/git/refs (list) and /git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs' && method === 'GET') {
      if (rest.length === 2) {
        const refs = [...repo.refs.keys()].sort().map((refName) => ({ ref: refName, object: { sha: repo.refs.get(refName) } }));
        sendJson(res, store, 200, refs);
        return;
      }
      if (rest.length >= 4 && rest[2] === 'heads') {
        const branch = rest.slice(3).map(decodeSegment).join('/');
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          jsonError(res, store, 404, 'Not Found');
          return;
        }
        sendJson(res, store, 200, { ref: `refs/heads/${branch}`, object: { sha } });
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    // GET /repos/{o}/{r}/branches
    if (rest.length === 1 && rest[0] === 'branches' && method === 'GET') {
      const branches = [...repo.refs.keys()]
        .filter((refName) => refName.startsWith('refs/heads/'))
        .sort()
        .map((refName) => ({ name: refName.slice('refs/heads/'.length), commit: { sha: repo.refs.get(refName) } }));
      sendJson(res, store, 200, branches);
      return;
    }
    // GET /repos/{o}/{r}/branches/{branch}
    if (rest.length >= 2 && rest[0] === 'branches' && method === 'GET') {
      const branch = rest.slice(1).map(decodeSegment).join('/');
      const sha = repo.refs.get(`refs/heads/${branch}`);
      if (sha === undefined) {
        jsonError(res, store, 404, 'Not Found');
        return;
      }
      sendJson(res, store, 200, { name: branch, commit: { sha } });
      return;
    }
    // GET /repos/{o}/{r}/commits
    if (rest.length === 1 && rest[0] === 'commits' && method === 'GET') {
      const shaParam = query.get('sha');
      let tip: string | undefined;
      if (shaParam !== null && shaParam !== '') {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? (repo.objects.has(shaParam) ? shaParam : undefined);
      } else {
        tip = branchTip(repo, repo.defaultBranch);
      }
      if (tip === undefined) {
        sendJson(res, store, 200, []);
        return;
      }
      sendJson(res, store, 200, commitList(repo, tip));
      return;
    }
    // /repos/{o}/{r}/contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).map(decodeSegment).join('/');
      const branch = query.get('ref') ?? repo.defaultBranch;
      if (method === 'PUT') {
        let input: Record<string, unknown>;
        try {
          input = parseBody();
        } catch {
          jsonError(res, store, 400, 'Problems parsing JSON');
          return;
        }
        const contentB64 = typeof input.content === 'string' ? input.content : '';
        const message = typeof input.message === 'string' ? input.message : 'Update file';
        const putBranch = typeof input.branch === 'string' && input.branch !== '' ? input.branch : branch;
        if (contentB64 === '') {
          jsonError(res, store, 422, 'content is required');
          return;
        }
        let content: Buffer;
        try {
          content = Buffer.from(contentB64, 'base64');
        } catch {
          jsonError(res, store, 422, 'content is not valid base64');
          return;
        }
        const tip = branchTip(repo, putBranch) ?? branchTip(repo, repo.defaultBranch);
        if (typeof input.sha === 'string' && input.sha !== '') {
          const currentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
          const current = currentTree === null ? undefined : flattenTree(repo.objects, currentTree).get(path);
          if (current === undefined || current.oid !== input.sha) {
            jsonError(res, store, 409, 'sha does not match the current file');
            return;
          }
        }
        const { commitSha, blobSha, created } = contentsCommit(store, repo, putBranch, path, content, message);
        const fileName = path.split('/').pop() ?? path;
        sendJson(res, store, created ? 201 : 200, {
          content: { name: fileName, path, sha: blobSha, size: content.length, encoding: 'base64', content: contentB64 },
          commit: { sha: commitSha },
        });
        return;
      }
      if (method === 'GET') {
        const tip = branchTip(repo, branch);
        if (tip === undefined) {
          jsonError(res, store, 404, 'Not Found');
          return;
        }
        const rootTree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
        const flat = flattenTree(repo.objects, rootTree);
        const file = flat.get(path);
        if (file !== undefined) {
          const object = repo.objects.get(file.oid);
          const data = object?.data ?? Buffer.alloc(0);
          sendJson(res, store, 200, {
            type: 'file',
            encoding: 'base64',
            name: path.split('/').pop() ?? path,
            path,
            content: data.toString('base64'),
            sha: file.oid,
            size: data.length,
          });
          return;
        }
        // Directory: immediate children of the prefix.
        const prefix = path === '' ? '' : `${path}/`;
        const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
        for (const [filePath, entry] of flat) {
          if (!filePath.startsWith(prefix)) continue;
          const restPath = filePath.slice(prefix.length);
          const slash = restPath.indexOf('/');
          if (slash < 0) {
            children.set(restPath, { type: 'file', name: restPath, path: filePath, sha: entry.oid });
          } else {
            const dirName = restPath.slice(0, slash);
            if (!children.has(dirName)) {
              const dirPath = prefix + dirName;
              const dirOid = subtreeOid(repo, rootTree, dirPath) ?? '';
              children.set(dirName, { type: 'dir', name: dirName, path: dirPath, sha: dirOid });
            }
          }
        }
        if (children.size === 0) {
          jsonError(res, store, 404, 'Not Found');
          return;
        }
        sendJson(res, store, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
        return;
      }
      if (method === 'DELETE') {
        let input: Record<string, unknown>;
        try {
          input = parseBody();
        } catch {
          jsonError(res, store, 400, 'Problems parsing JSON');
          return;
        }
        const message = typeof input.message === 'string' ? input.message : 'Delete file';
        const tip = branchTip(repo, branch);
        if (tip === undefined) {
          jsonError(res, store, 404, 'Not Found');
          return;
        }
        const currentTree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
        const current = flattenTree(repo.objects, currentTree).get(path);
        if (current === undefined) {
          jsonError(res, store, 404, 'Not Found');
          return;
        }
        if (typeof input.sha === 'string' && input.sha !== '' && input.sha !== current.oid) {
          jsonError(res, store, 409, 'sha does not match the current file');
          return;
        }
        const { commitSha } = contentsCommit(store, repo, branch, path, null, message);
        sendJson(res, store, 200, { commit: { sha: commitSha } });
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    // POST /repos/{o}/{r}/labels
    if (rest.length === 1 && rest[0] === 'labels') {
      if (method === 'GET') {
        sendJson(res, store, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color })));
        return;
      }
      if (method === 'POST') {
        let input: Record<string, unknown>;
        try {
          input = parseBody();
        } catch {
          jsonError(res, store, 400, 'Problems parsing JSON');
          return;
        }
        const labelName = typeof input.name === 'string' ? input.name : '';
        if (labelName === '') {
          jsonError(res, store, 422, 'name is required');
          return;
        }
        const color = typeof input.color === 'string' ? input.color : 'ededed';
        repo.labels.set(labelName, { name: labelName, color });
        sendJson(res, store, 201, { name: labelName, color });
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    // /repos/{o}/{r}/issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          const direction = query.get('direction') ?? 'asc';
          let issues = [...repo.issues.values()];
          if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
          issues.sort((a, b) => (direction === 'desc' ? b.number - a.number : a.number - b.number));
          sendJson(res, store, 200, issues.map((issue) => issueJson(repo, issue)));
          return;
        }
        if (method === 'POST') {
          let input: Record<string, unknown>;
          try {
            input = parseBody();
          } catch {
            jsonError(res, store, 400, 'Problems parsing JSON');
            return;
          }
          const title = typeof input.title === 'string' ? input.title : '';
          if (title === '') {
            jsonError(res, store, 422, 'title is required');
            return;
          }
          const labelsRaw = Array.isArray(input.labels) ? input.labels : [];
          const labels: string[] = [];
          for (const entry of labelsRaw) {
            const labelName = typeof entry === 'string' ? entry : typeof entry === 'object' && entry !== null ? String((entry as Record<string, unknown>).name ?? '') : '';
            if (labelName === '') continue;
            if (!repo.labels.has(labelName)) {
              jsonError(res, store, 422, `Label "${labelName}" does not exist`);
              return;
            }
            labels.push(labelName);
          }
          const issue = store.createIssue(repo, title, typeof input.body === 'string' ? input.body : '', labels);
          sendJson(res, store, 201, issueJson(repo, issue));
          return;
        }
        jsonError(res, store, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const issue = repo.issues.get(number);
      if (issue === undefined) {
        jsonError(res, store, 404, 'Not Found');
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, store, 200, issueJson(repo, issue));
          return;
        }
        if (method === 'PATCH') {
          let input: Record<string, unknown>;
          try {
            input = parseBody();
          } catch {
            jsonError(res, store, 400, 'Problems parsing JSON');
            return;
          }
          if (typeof input.title === 'string') issue.title = input.title;
          if (typeof input.body === 'string') issue.body = input.body;
          if (typeof input.state === 'string' && (input.state === 'open' || input.state === 'closed')) issue.state = input.state;
          issue.updatedAt = store.nowIso();
          sendJson(res, store, 200, issueJson(repo, issue));
          return;
        }
        jsonError(res, store, 404, 'Not Found');
        return;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          sendJson(res, store, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
          return;
        }
        if (method === 'POST') {
          let input: Record<string, unknown>;
          try {
            input = parseBody();
          } catch {
            jsonError(res, store, 400, 'Problems parsing JSON');
            return;
          }
          const commentBody = typeof input.body === 'string' ? input.body : '';
          if (commentBody === '') {
            jsonError(res, store, 422, 'body is required');
            return;
          }
          const comment = store.addComment(repo, issue, commentBody);
          sendJson(res, store, 201, commentJson(repo, issue, comment));
          return;
        }
        jsonError(res, store, 404, 'Not Found');
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = query.get('state') ?? 'open';
          let pulls = [...repo.pulls.values()];
          if (state === 'open' || state === 'closed') pulls = pulls.filter((pull) => pull.state === state);
          pulls.sort((a, b) => a.number - b.number);
          sendJson(res, store, 200, pulls.map((pull) => pullJson(repo, pull)));
          return;
        }
        if (method === 'POST') {
          let input: Record<string, unknown>;
          try {
            input = parseBody();
          } catch {
            jsonError(res, store, 400, 'Problems parsing JSON');
            return;
          }
          const title = typeof input.title === 'string' ? input.title : '';
          const head = typeof input.head === 'string' ? input.head : '';
          const base = typeof input.base === 'string' ? input.base : '';
          if (title === '' || head === '' || base === '') {
            jsonError(res, store, 422, 'title, head, and base are required');
            return;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined) {
            jsonError(res, store, 422, `Head branch ${head} does not exist`);
            return;
          }
          if (baseSha === undefined) {
            jsonError(res, store, 422, `Base branch ${base} does not exist`);
            return;
          }
          const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
          if (duplicate !== undefined) {
            jsonError(res, store, 422, 'A pull request already exists for this head and base');
            return;
          }
          const pull = store.createPull(repo, title, typeof input.body === 'string' ? input.body : '', head, base, headSha, baseSha);
          sendJson(res, store, 201, pullJson(repo, pull));
          return;
        }
        jsonError(res, store, 404, 'Not Found');
        return;
      }
      const number = Number.parseInt(rest[1] as string, 10);
      const pull = repo.pulls.get(number);
      if (pull === undefined) {
        jsonError(res, store, 404, 'Not Found');
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(res, store, 200, pullJson(repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const base = mergeBase(repo.objects, pull.headSha, pull.baseSha);
        const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
        const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
        const files = diffTrees(repo.objects, baseTree, headTree).map((diff) => {
          let additions = 0;
          let deletions = 0;
          if (diff.status === 'added' && diff.newOid !== null) additions = lineCounts(repo, diff.newOid);
          else if (diff.status === 'removed' && diff.oldOid !== null) deletions = lineCounts(repo, diff.oldOid);
          else if (diff.oldOid !== null && diff.newOid !== null) {
            const counts = lineDiffCounts(repo, diff.oldOid, diff.newOid);
            additions = counts.additions;
            deletions = counts.deletions;
          }
          return { filename: diff.path, status: diff.status, additions, deletions, changes: additions + deletions };
        });
        sendJson(res, store, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open') {
          jsonError(res, store, 404, 'Not Found');
          return;
        }
        if (computeMergeable(repo, pull) === 'CONFLICTING') {
          jsonError(res, store, 405, 'Pull request has merge conflicts');
          return;
        }
        const merged = squashMerge(repo, pull, () => store.nowSec());
        if (merged === null) {
          jsonError(res, store, 404, 'Not Found');
          return;
        }
        sendJson(res, store, 200, { sha: merged, merged: true, message: `Merged pull request #${pull.number}` });
        return;
      }
      jsonError(res, store, 404, 'Not Found');
      return;
    }
    jsonError(res, store, 404, 'Not Found');
    return;
  }

  jsonError(res, store, 404, 'Not Found');
}

// ---------------------------------------------------------------- server

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { path, query } = requestUrl(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, store, 200, { ok: true });
          return;
        }

        // Git smart HTTP at /{owner}/{repo}.git
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch !== null) {
          const owner = decodeSegment(gitMatch[1] as string);
          const repoName = decodeSegment(gitMatch[2] as string);
          const tail = gitMatch[3] ?? '';
          const repo = store.getRepo(owner, repoName);
          if (repo === undefined) {
            jsonError(res, store, 404, 'Not Found');
            return;
          }
          if (method === 'GET' && tail.startsWith('/info/refs')) {
            const service = query.get('service') ?? '';
            if (service === 'git-upload-pack' || service === 'git-receive-pack') {
              handleAdvertisement(store, repo, service, req, res);
              return;
            }
            jsonError(res, store, 404, 'Not Found');
            return;
          }
          if (method === 'POST' && tail === '/git-upload-pack') {
            const body = await readBody(req);
            if ((req.headers['git-protocol'] ?? '') === 'version=2') handleUploadPackV2(store, repo, body, res);
            else handleUploadPackV0(store, repo, body, res);
            return;
          }
          if (method === 'POST' && tail === '/git-receive-pack') {
            const body = await readBody(req);
            handleReceivePack(store, repo, body, res);
            return;
          }
          jsonError(res, store, 404, 'Not Found');
          return;
        }

        // GraphQL v4 at /api/graphql
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            jsonError(res, store, 404, 'Not Found');
            return;
          }
          if (!authorized(req)) {
            jsonError(res, store, 401, 'Requires authentication');
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            jsonError(res, store, 400, 'Problems parsing JSON');
            return;
          }
          const result = executeGraphQLBatch(store, parsed);
          sendJson(res, store, 200, result);
          return;
        }

        // MCP at /mcp
        if (path === '/mcp') {
          if (method !== 'POST') {
            jsonError(res, store, 404, 'Not Found');
            return;
          }
          if (!authorized(req)) {
            jsonError(res, store, 401, 'Requires authentication');
            return;
          }
          const body = await readBody(req);
          let parsed: unknown;
          try {
            parsed = JSON.parse(body.toString('utf8'));
          } catch {
            const outcome = mcpParseError();
            sendJson(res, store, outcome.status, outcome.body);
            return;
          }
          if (parsed === null || typeof parsed !== 'object') {
            const outcome = mcpParseError();
            sendJson(res, store, outcome.status, outcome.body);
            return;
          }
          const outcome = handleMcpRequest(store, parsed as Record<string, unknown>);
          if (outcome.body === null) {
            res.writeHead(outcome.status);
            res.end();
            return;
          }
          sendJson(res, store, outcome.status, outcome.body);
          return;
        }

        // REST v3 under /api/v3
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          if (!authorized(req)) {
            jsonError(res, store, 401, 'Requires authentication');
            return;
          }
          const segments = path
            .replace(/^\/api\/v3\/?/, '')
            .split('/')
            .filter((segment) => segment !== '')
            .map(decodeSegment);
          const body = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          await handleRest(store, req, res, segments, query, body);
          return;
        }

        // Everything else: GitHub's 404 body.
        jsonError(res, store, 404, 'Not Found');
      } catch (error) {
        // A handler must never crash the server: answer 500 JSON and keep serving.
        try {
          jsonError(res, store, 500, error instanceof Error ? error.message : 'Internal Server Error');
        } catch {
          try {
            res.writeHead(500);
            res.end();
          } catch {
            // The socket is gone; nothing left to do.
          }
        }
      }
    })();
  });
}
