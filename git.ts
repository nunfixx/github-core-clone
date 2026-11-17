// git.ts — the git object model and the smart-HTTP wire, written by hand on node:zlib +
// node:crypto. No git binary anywhere: objects are hashed, packed, parsed and walked here.
// Determinism: object ids are content hashes; pack entry order is sorted by oid; no clock or
// randomness enters any of it.

import { createHash } from 'node:crypto';
import { inflateSync as zlibInflate, deflateSync as zlibDeflate } from 'node:zlib';
import { ZERO_OID } from './scenario.ts';

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  readonly type: ObjectType;
  readonly data: Buffer;
}

export const OBJECT_TYPE_CODE: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
export const OBJECT_CODE_TYPE: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** The SHA-1 id of `type` + `data`, exactly as git hashes it. */
export function hashObject(type: ObjectType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(header).update(data).digest('hex');
}

/** Store `data` as an object of `type` in `objects` (by content hash); returns the oid. */
export function putObject(objects: Map<string, GitObject>, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!objects.has(oid)) objects.set(oid, { type, data });
  return oid;
}

// ---------------------------------------------------------------- commits

export interface ParsedCommit {
  readonly tree: string;
  readonly parents: string[];
  readonly author: string;
  readonly committer: string;
  readonly message: string;
}

export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function buildCommit(commit: ParsedCommit): Buffer {
  let head = `tree ${commit.tree}\n`;
  for (const parent of commit.parents) head += `parent ${parent}\n`;
  head += `author ${commit.author}\ncommitter ${commit.committer}\n`;
  return Buffer.from(`${head}\n${commit.message}`, 'utf8');
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  readonly mode: string;
  readonly name: string;
  readonly oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) break;
    const mode = data.subarray(offset, space).toString('utf8');
    const nul = data.indexOf(0x00, space);
    if (nul < 0) break;
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree order: names compared as bytes, directories as if suffixed with '/'. */
export function treeSortKey(entry: TreeEntry): string {
  return entry.mode === '40000' ? `${entry.name}/` : entry.name;
}

export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = entries.slice().sort((a, b) => {
    const ka = treeSortKey(a);
    const kb = treeSortKey(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- tags

export interface ParsedTag {
  readonly object: string;
  readonly type: ObjectType;
  readonly tag: string;
  readonly tagger: string;
  readonly message: string;
}

export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const headEnd = text.indexOf('\n\n');
  const head = headEnd >= 0 ? text.slice(0, headEnd) : text;
  const message = headEnd >= 0 ? text.slice(headEnd + 2) : '';
  let object = '';
  let type: ObjectType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjectType;
    else if (line.startsWith('tag ')) tag = line.slice(4);
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

// ---------------------------------------------------------------- pkt-lines

/** One pkt-line: 4 hex digits of (payload length + 4) + payload. */
export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const length = body.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0'), 'utf8'), body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'utf8');
export const PKT_DELIM = Buffer.from('0001', 'utf8');

export type PktKind = 'data' | 'flush' | 'delim';

export interface PktPacket {
  readonly kind: PktKind;
  readonly payload: Buffer;
}

/** Parse a whole buffer of pkt-lines into packets (flush/delim/data). */
export function parsePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const lenText = buffer.subarray(offset, offset + 4).toString('utf8');
    const length = parseInt(lenText, 16);
    if (!Number.isFinite(length)) break;
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) break;
    packets.push({ kind: 'data', payload: Buffer.from(buffer.subarray(offset + 4, offset + length)) });
    offset += length;
  }
  return packets;
}

/** The text lines of data packets, without trailing newlines. */
export function pktTextLines(buffer: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of parsePktLines(buffer)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

// ---------------------------------------------------------------- sideband

const SIDEBAND_MAX = 65515;

/** Wrap `data` in sideband band-1 packets (pack bytes), chunked to the pkt-line limit. */
export function sidebandPack(data: Buffer): Buffer {
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_MAX) {
    const slice = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_MAX));
    const payload = Buffer.concat([Buffer.from([1]), slice]);
    chunks.push(pktLine(payload));
  }
  return Buffer.concat(chunks);
}

// ---------------------------------------------------------------- packfiles

function encodePackVarint(firstByteBase: number, value: number): Buffer {
  // Header varint: low 4 bits in the first byte, then 7 bits per byte, MSB = more bytes follow.
  // Every byte but the last carries the continuation bit.
  const bytes: number[] = [];
  let size = value;
  bytes.push(firstByteBase | (size & 0x0f));
  size >>>= 4;
  while (size > 0) {
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] as number) | 0x80;
    bytes.push(size & 0x7f);
    size >>>= 7;
  }
  return Buffer.from(bytes);
}

/** Write a pack v2 of plain objects (no deltas), entries sorted by oid for determinism. */
export function writePack(objects: Map<string, GitObject>): Buffer {
  const entries = [...objects.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'utf8');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  parts.push(header);
  for (const [, object] of entries) {
    const code = OBJECT_TYPE_CODE[object.type];
    parts.push(encodePackVarint(code << 4, object.data.length));
    parts.push(zlibDeflate(object.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = createHash('sha1').update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

function readVarint(data: Buffer, offset: number): { value: number; next: number } {
  let byte = data[offset] ?? 0;
  let value = byte & 0x7f;
  let next = offset + 1;
  let shift = 7;
  while (byte & 0x80) {
    byte = data[next] ?? 0;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    next += 1;
  }
  return { value, next };
}

function readOfsDeltaOffset(data: Buffer, offset: number): { value: number; next: number } {
  let byte = data[offset] ?? 0;
  let value = byte & 0x7f;
  let next = offset + 1;
  while (byte & 0x80) {
    byte = data[next] ?? 0;
    value = ((value + 1) << 7) | (byte & 0x7f);
    next += 1;
  }
  return { value, next };
}

/** Apply a git delta to `base`, returning the reconstructed object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    const { value, next } = readVarint(delta, offset);
    offset = next;
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta source size mismatch');
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const opcode = delta[offset] ?? 0;
    offset += 1;
    if (opcode & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let i = 0; i < 4; i += 1) {
        if (opcode & (1 << i)) {
          copyOffset |= (delta[offset] ?? 0) << (i * 8);
          offset += 1;
        }
      }
      for (let i = 0; i < 3; i += 1) {
        if (opcode & (0x10 << i)) {
          copySize |= (delta[offset] ?? 0) << (i * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (opcode !== 0) {
      out.push(delta.subarray(offset, offset + opcode));
      produced += opcode;
      offset += opcode;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (produced !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(out);
}

export interface ReadPackResult {
  readonly objects: Map<string, GitObject>;
  readonly deltaCount: number;
}

/** Read a pack v2/v3, resolving OFS_DELTA and REF_DELTA entries. `resolveBase` answers for bases held outside the pack. */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): ReadPackResult {
  if (pack.length < 12 || pack.subarray(0, 4).toString('utf8') !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const rawEntries: Array<{ type: ObjectType; data: Buffer; baseOid?: string; baseOffset?: number }> = [];
  const offsetByIndex: number[] = [];
  let offset = 12;
  let deltaCount = 0;
  for (let i = 0; i < count; i += 1) {
    offsetByIndex.push(offset);
    const first = pack[offset] ?? 0;
    const typeCode = (first >> 4) & 0x07;
    let size = first & 0x0f;
    let shift = 4;
    let pos = offset + 1;
    while (pack[pos - 1] !== undefined && (pack[pos - 1] as number) & 0x80) {
      size |= ((pack[pos] ?? 0) & 0x7f) << shift;
      shift += 7;
      pos += 1;
    }
    offset = pos;
    if (typeCode === 6) {
      const { value, next } = readOfsDeltaOffset(pack, offset);
      const baseOffset = offsetByIndex[i] as number - value;
      const data = zlibInflate(pack.subarray(next));
      offset = next + consumedDeflateLength(pack, next, size);
      rawEntries.push({ type: 'blob', data, baseOffset });
      deltaCount += 1;
      continue;
    }
    if (typeCode === 7) {
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const data = zlibInflate(pack.subarray(offset));
      offset += consumedDeflateLength(pack, offset, size);
      rawEntries.push({ type: 'blob', data, baseOid });
      deltaCount += 1;
      continue;
    }
    const type = OBJECT_CODE_TYPE[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const data = zlibInflate(pack.subarray(offset));
    offset += consumedDeflateLength(pack, offset, size);
    if (data.length !== size) throw new Error('pack object size mismatch');
    rawEntries.push({ type, data });
  }
  // Resolve entries in order; a delta's base may be any earlier entry or an outside object.
  const resolved: Array<GitObject | null> = rawEntries.map(() => null);
  const resolveEntry = (index: number): GitObject => {
    const cached = resolved[index];
    if (cached) return cached;
    const entry = rawEntries[index] as (typeof rawEntries)[number];
    let result: GitObject;
    if (entry.baseOffset !== undefined) {
      const baseIndex = offsetByIndex.indexOf(entry.baseOffset);
      if (baseIndex < 0) throw new Error('ofs-delta base outside the pack');
      const base = resolveEntry(baseIndex);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else if (entry.baseOid !== undefined) {
      const base = objects.get(entry.baseOid) ?? resolveBase?.(entry.baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${entry.baseOid} is unknown`);
      result = { type: base.type, data: applyDelta(base.data, entry.data) };
    } else {
      result = { type: entry.type, data: entry.data };
    }
    resolved[index] = result;
    objects.set(hashObject(result.type, result.data), result);
    return result;
  };
  for (let i = 0; i < rawEntries.length; i += 1) resolveEntry(i);
  return { objects, deltaCount };
}

/** How many bytes a zlib stream starting at `offset` consumed. Fast path: one inflate with
 *  `{ info: true }`; the engine reports exactly how many input bytes the stream consumed
 *  (`bytesWritten`), verified against the expected output size, so no binary search and no
 *  deliberately-thrown errors (each thrown inflate builds a full stack trace). Falls back to the
 *  binary search below when the engine does not report a usable length, preserving the old
 *  behaviour (including the corrupt-stream error) byte for byte. */
function consumedDeflateLength(data: Buffer, offset: number, expectedSize: number): number {
  try {
    const result = zlibInflate(data.subarray(offset), { info: true }) as unknown as {
      buffer: Buffer;
      engine: { bytesWritten?: unknown };
    };
    const consumed = result.engine.bytesWritten;
    if (
      typeof consumed === 'number' &&
      Number.isInteger(consumed) &&
      consumed > 0 &&
      consumed <= data.length - offset &&
      result.buffer.length === expectedSize
    ) {
      return consumed;
    }
  } catch {
    // Fall through to the binary search.
  }
  return consumedDeflateLengthSlow(data, offset, expectedSize);
}

/** The old binary search for a stream's end: the smallest prefix that inflates cleanly is the
 *  stream's true end (inflateSync ignores trailing bytes). A deflate stream never expands past
 *  its input by more than stored-block overhead, so the search window is `expectedSize` + slack. */
function consumedDeflateLengthSlow(data: Buffer, offset: number, expectedSize: number): number {
  const high = Math.min(data.length, offset + expectedSize + Math.floor(expectedSize / 1000) + 32);
  let low = offset + 1;
  let end = high;
  // First confirm the window holds a complete stream; otherwise fall back to the whole remainder.
  try {
    zlibInflate(data.subarray(offset, high));
  } catch {
    if (high < data.length) {
      try {
        zlibInflate(data.subarray(offset, data.length));
      } catch {
        throw new Error('corrupt deflate stream in pack');
      }
      end = data.length;
    } else {
      throw new Error('corrupt deflate stream in pack');
    }
  }
  while (low < end) {
    const mid = Math.floor((low + end) / 2);
    try {
      zlibInflate(data.subarray(offset, mid));
      end = mid;
    } catch {
      low = mid + 1;
    }
  }
  return end - offset;
}

// ---------------------------------------------------------------- reachability

export interface RepoObjects {
  readonly objects: Map<string, GitObject>;
}

/** The commit objects reachable from `tips` (first-parent and all parents), with generation depth. */
export function reachableCommits(
  objects: Map<string, GitObject>,
  tips: readonly string[],
  maxDepth?: number,
): Map<string, number> {
  const generations = new Map<string, number>();
  const queue: Array<{ oid: string; generation: number }> = [];
  for (const tip of tips) {
    if (tip === ZERO_OID) continue;
    const object = objects.get(tip);
    if (object === undefined) continue;
    if (object.type === 'tag') {
      const tag = parseTag(object.data);
      if (tag.type === 'commit' && !generations.has(tag.object)) {
        generations.set(tag.object, 0);
        queue.push({ oid: tag.object, generation: 0 });
      }
      continue;
    }
    if (object.type !== 'commit') continue;
    if (!generations.has(tip)) {
      generations.set(tip, 0);
      queue.push({ oid: tip, generation: 0 });
    }
  }
  while (queue.length > 0) {
    const current = queue.shift() as { oid: string; generation: number };
    if (maxDepth !== undefined && current.generation + 1 >= maxDepth) continue;
    const object = objects.get(current.oid);
    if (object === undefined || object.type !== 'commit') continue;
    const commit = parseCommit(object.data);
    for (const parent of commit.parents) {
      if (!generations.has(parent)) {
        generations.set(parent, current.generation + 1);
        queue.push({ oid: parent, generation: current.generation + 1 });
      }
    }
  }
  return generations;
}

/** `true` when `ancestor` is reachable from `descendant` (or equal). */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  if (ancestor === ZERO_OID) return true;
  const seen = new Set<string>([descendant]);
  const queue = [descendant];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) {
      if (parent === ancestor) return true;
      if (!seen.has(parent)) {
        seen.add(parent);
        queue.push(parent);
      }
    }
  }
  return false;
}

/** The merge-base of two commits: the first common ancestor by generation (BFS from both). */
export function mergeBase(objects: Map<string, GitObject>, a: string, b: string): string | null {
  if (a === b) return a;
  const fromA = reachableCommits(objects, [a]);
  const fromB = reachableCommits(objects, [b]);
  let best: string | null = null;
  let bestGen = Number.POSITIVE_INFINITY;
  for (const [oid, genA] of fromA) {
    const genB = fromB.get(oid);
    if (genB === undefined) continue;
    const total = genA + genB;
    if (total < bestGen) {
      bestGen = total;
      best = oid;
    }
  }
  return best;
}

/** Collect a tree's blobs and subtrees, recursively, into `out`. */
export function collectTree(objects: Map<string, GitObject>, treeOid: string, out: Map<string, GitObject>): void {
  const stack = [treeOid];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = objects.get(oid);
    if (object === undefined) continue;
    out.set(oid, object);
    if (object.type !== 'tree') continue;
    for (const entry of parseTree(object.data)) {
      const child = objects.get(entry.oid);
      if (child === undefined) continue;
      if (entry.mode === '40000') stack.push(entry.oid);
      else out.set(entry.oid, child);
    }
  }
}

/** Flatten a tree to path -> {mode, oid} (recursive, '/' joined). */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string): Map<string, { mode: string; oid: string }> {
  const out = new Map<string, { mode: string; oid: string }>();
  const walk = (oid: string, prefix: string): void => {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'tree') return;
    for (const entry of parseTree(object.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000') walk(entry.oid, path);
      else out.set(path, { mode: entry.mode, oid: entry.oid });
    }
  };
  walk(treeOid, '');
  return out;
}

/**
 * Build a tree from a flat path map, creating intermediate trees in `objects`; returns the root oid.
 * `entries` maps path -> {mode, oid}; a missing path means "not present".
 */
export function buildTreeFromEntries(
  objects: Map<string, GitObject>,
  entries: Map<string, { mode: string; oid: string }>,
): string {
  const buildLevel = (prefix: string): string => {
    const levelEntries: TreeEntry[] = [];
    const dirs = new Set<string>();
    for (const [path, value] of entries) {
      if (prefix !== '' && !path.startsWith(`${prefix}/`)) continue;
      const rest = prefix === '' ? path : path.slice(prefix.length + 1);
      const slash = rest.indexOf('/');
      if (slash < 0) levelEntries.push({ mode: value.mode, name: rest, oid: value.oid });
      else dirs.add(rest.slice(0, slash));
    }
    for (const dir of dirs) {
      const subPrefix = prefix === '' ? dir : `${prefix}/${dir}`;
      levelEntries.push({ mode: '40000', name: dir, oid: buildLevel(subPrefix) });
    }
    return putObject(objects, 'tree', buildTree(levelEntries));
  };
  return buildLevel('');
}

/** The changed paths between two trees: added / modified / removed, with old/new blob oids. */
export interface TreeDiff {
  readonly path: string;
  readonly status: 'added' | 'modified' | 'removed';
  readonly oldOid: string | null;
  readonly newOid: string | null;
}

export function diffTrees(
  objects: Map<string, GitObject>,
  baseTreeOid: string | null,
  headTreeOid: string | null,
): TreeDiff[] {
  const base = baseTreeOid === null ? new Map() : flattenTree(objects, baseTreeOid);
  const head = headTreeOid === null ? new Map() : flattenTree(objects, headTreeOid);
  const diffs: TreeDiff[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of paths) {
    const b = base.get(path);
    const h = head.get(path);
    if (b === undefined && h !== undefined) diffs.push({ path, status: 'added', oldOid: null, newOid: h.oid });
    else if (b !== undefined && h === undefined) diffs.push({ path, status: 'removed', oldOid: b.oid, newOid: null });
    else if (b !== undefined && h !== undefined && b.oid !== h.oid) {
      diffs.push({ path, status: 'modified', oldOid: b.oid, newOid: h.oid });
    }
  }
  diffs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return diffs;
}
