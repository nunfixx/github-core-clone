// merge.ts — the one merge implementation REST and GraphQL share, so a PR merged over either
// surface reads back identically over the other. Squash only: one commit, parent = base tip,
// tree = base tree with the head's changes since the merge-base applied.

import type { Repo, PullRequest } from './store.ts';
import {
  buildCommit,
  buildTreeFromEntries,
  diffTrees,
  flattenTree,
  isAncestor,
  mergeBase,
  parseCommit,
  putObject,
} from './git.ts';
import { viewerUser } from './scenario.ts';

/** Paths changed on `side` since `baseCommit`, as a map path -> new blob oid (null = deleted). */
function changedSince(repo: Repo, baseCommit: string | null, sideTip: string): Map<string, string | null> {
  const baseTree = baseCommit === null ? null : parseCommit(repo.objects.get(baseCommit)?.data ?? Buffer.alloc(0)).tree;
  const sideTree = parseCommit(repo.objects.get(sideTip)?.data ?? Buffer.alloc(0)).tree;
  const diffs = diffTrees(repo.objects, baseTree, sideTree);
  const out = new Map<string, string | null>();
  for (const diff of diffs) out.set(diff.path, diff.newOid);
  return out;
}

/** 'MERGEABLE' | 'CONFLICTING': a conflict is a path changed on both sides with different results.
 *  The tips are re-resolved from the live refs: the base may have moved since the PR was opened. */
export function computeMergeable(repo: Repo, pull: PullRequest): 'MERGEABLE' | 'CONFLICTING' {
  const headSha = repo.refs.get(`refs/heads/${pull.headRef}`) ?? pull.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
  const base = mergeBase(repo.objects, headSha, baseSha);
  if (base === null) return 'MERGEABLE';
  const headChanges = changedSince(repo, base, headSha);
  const baseChanges = changedSince(repo, base, baseSha);
  for (const [path, headOid] of headChanges) {
    if (!baseChanges.has(path)) continue;
    const baseOid = baseChanges.get(path);
    if (baseOid !== headOid) return 'CONFLICTING';
  }
  return 'MERGEABLE';
}

/**
 * Squash-merge `pull` onto its base branch. Returns the merge commit oid, or null when the PR is
 * already closed / the refs are missing. On conflict the caller must refuse (405) instead.
 */
export function squashMerge(
  repo: Repo,
  pull: PullRequest,
  nowSec: () => number,
): string | null {
  if (pull.state !== 'open') return null;
  const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`);
  const headTip = repo.refs.get(`refs/heads/${pull.headRef}`);
  if (baseTip === undefined || headTip === undefined) return null;
  const base = mergeBase(repo.objects, headTip, baseTip);
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const baseTreeNow = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  // Start from the base tip's tree, apply the head's changes since the merge-base.
  const entries = flattenTree(repo.objects, baseTreeNow);
  for (const diff of diffTrees(repo.objects, baseTree, headTree)) {
    if (diff.newOid === null) entries.delete(diff.path);
    else entries.set(diff.path, { mode: '100644', oid: diff.newOid });
  }
  const mergedTree = buildTreeFromEntries(repo.objects, entries);
  const viewer = viewerUser();
  const stamp = nowSec();
  const identity = `${viewer.name} <${viewer.email}> ${stamp} +0000`;
  const commit = buildCommit({
    tree: mergedTree,
    parents: [baseTip],
    author: identity,
    committer: identity,
    message: `${pull.title}\n`,
  });
  const mergeSha = putObject(repo.objects, 'commit', commit);
  repo.refs.set(`refs/heads/${pull.baseRef}`, mergeSha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergeCommitSha = mergeSha;
  pull.mergedAt = new Date(stamp * 1000).toISOString();
  pull.updatedAt = pull.mergedAt;
  pull.baseSha = mergeSha;
  return mergeSha;
}

/** Fast-forward test for a push: `newOid` must descend from `oldOid` (or old is the zero oid). */
export function isFastForward(repo: Repo, oldOid: string, newOid: string): boolean {
  if (oldOid === '0000000000000000000000000000000000000000') return true;
  return isAncestor(repo.objects, oldOid, newOid);
}
