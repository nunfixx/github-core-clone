// store.ts — the forge's whole state, in memory. Repos, git objects, refs, issues, pull requests,
// labels and comments live here and nowhere else, so REST, GraphQL and MCP always read the same
// objects with the same ids.
//
// Determinism: every timestamp comes from a monotonic counter seeded by MAKEFUN_TRIAL_NOW (or the
// scenario epoch when the env does not set it). No Date.now(), no Math.random(), no random UUIDs.

import { SCENARIO_EPOCH_SEC, viewerUser } from './scenario.ts';
import type { GitObject } from './git.ts';

export interface Comment {
  readonly id: number;
  readonly body: string;
  readonly user: string;
  readonly createdAt: string;
}

export interface Issue {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  readonly user: string;
  readonly createdAt: string;
  updatedAt: string;
  comments: Comment[];
}

export interface PullRequest {
  readonly id: number;
  readonly number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  readonly headRef: string;
  readonly baseRef: string;
  headSha: string;
  baseSha: string;
  readonly user: string;
  readonly createdAt: string;
  updatedAt: string;
}

export interface Label {
  readonly name: string;
  color: string;
}

export interface Repo {
  readonly id: number;
  readonly owner: string;
  readonly name: string;
  description: string;
  isPrivate: boolean;
  readonly defaultBranch: string;
  readonly createdAt: string;
  updatedAt: string;
  /** Git objects by oid. */
  readonly objects: Map<string, GitObject>;
  /** Full ref names (refs/heads/..., refs/tags/...) -> oid. */
  readonly refs: Map<string, string>;
  readonly issues: Map<number, Issue>;
  readonly pulls: Map<number, PullRequest>;
  readonly labels: Map<string, Label>;
  nextIssue: number;
  nextPull: number;
  nextCommentId: number;
  /** Shallow boundaries recorded by fetches (oid -> true), for shallow-info bookkeeping. */
  shallow: Set<string>;
}

function globalId(kind: string, ...parts: Array<string | number>): string {
  return Buffer.from(`${kind}:${parts.join(':')}`, 'utf8').toString('base64');
}

export function repoGlobalId(repoId: number): string {
  return globalId('Repository', repoId);
}

export function issueGlobalId(repoId: number, number: number): string {
  return globalId('Issue', repoId, number);
}

export function pullGlobalId(repoId: number, number: number): string {
  return globalId('PullRequest', repoId, number);
}

export function commentGlobalId(repoId: number, issueNumber: number, commentId: number): string {
  return globalId('IssueComment', repoId, issueNumber, commentId);
}

/** Decode a global id back to {kind, parts}, or null when it is not one of ours. */
export function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  let text: string;
  try {
    text = Buffer.from(id, 'base64').toString('utf8');
  } catch {
    return null;
  }
  // Re-encoding must round-trip, or the input was not a base64 id at all.
  if (Buffer.from(text, 'utf8').toString('base64') !== id) return null;
  const colon = text.indexOf(':');
  if (colon <= 0) return null;
  return { kind: text.slice(0, colon), parts: text.slice(colon + 1).split(':') };
}

export class Store {
  readonly repos = new Map<string, Repo>();
  readonly reposById = new Map<number, Repo>();
  private nextRepoId = 5000;
  private nextIssueId = 1;
  private nextPullId = 1;
  private readonly clockBase: number;
  private clockTick = 0;
  private requestCounter = 0;

  constructor() {
    const envNow = Number.parseInt(process.env.MAKEFUN_TRIAL_NOW ?? '', 10);
    this.clockBase = Number.isFinite(envNow) && envNow > 0 ? envNow : SCENARIO_EPOCH_SEC;
  }

  /** The next deterministic second (monotonic: every call advances the clock by one). */
  nowSec(): number {
    const sec = this.clockBase + this.clockTick;
    this.clockTick += 1;
    return sec;
  }

  nowIso(): string {
    return new Date(this.nowSec() * 1000).toISOString();
  }

  nextRequestId(): string {
    this.requestCounter += 1;
    return `req-${this.requestCounter}`;
  }

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  /** Create a repo, or null when `owner/name` already exists. */
  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.repoKey(owner, name);
    if (this.repos.has(key)) return null;
    const now = this.nowIso();
    const repo: Repo = {
      id: this.nextRepoId,
      owner,
      name,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      objects: new Map(),
      refs: new Map(),
      issues: new Map(),
      pulls: new Map(),
      labels: new Map(),
      nextIssue: 1,
      nextPull: 1,
      nextCommentId: 1,
      shallow: new Set(),
    };
    this.nextRepoId += 1;
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    const key = this.repoKey(owner, name);
    const repo = this.repos.get(key);
    if (repo === undefined) return false;
    this.repos.delete(key);
    this.reposById.delete(repo.id);
    return true;
  }

  /** The viewer's repos, in creation order. */
  viewerRepos(): Repo[] {
    const viewer = viewerUser().login;
    const out: Repo[] = [];
    for (const repo of this.repos.values()) {
      if (repo.owner === viewer) out.push(repo);
    }
    return out;
  }

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const number = repo.nextIssue;
    repo.nextIssue += 1;
    const now = this.nowIso();
    const issue: Issue = {
      id: this.nextIssueId,
      number,
      title,
      body,
      state: 'open',
      labels: labels.slice(),
      user: viewerUser().login,
      createdAt: now,
      updatedAt: now,
      comments: [],
    };
    this.nextIssueId += 1;
    repo.issues.set(number, issue);
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, headRef: string, baseRef: string, headSha: string, baseSha: string): PullRequest {
    const number = repo.nextPull;
    repo.nextPull += 1;
    const now = this.nowIso();
    const pull: PullRequest = {
      id: this.nextPullId,
      number,
      title,
      body,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      headRef,
      baseRef,
      headSha,
      baseSha,
      user: viewerUser().login,
      createdAt: now,
      updatedAt: now,
    };
    this.nextPullId += 1;
    repo.pulls.set(number, pull);
    return pull;
  }

  addComment(repo: Repo, issue: Issue, body: string): Comment {
    const comment: Comment = {
      id: repo.nextCommentId,
      body,
      user: viewerUser().login,
      createdAt: this.nowIso(),
    };
    repo.nextCommentId += 1;
    issue.comments.push(comment);
    return comment;
  }
}

// ---------------------------------------------------------------- REST shapes

/** The public JSON shape of a repo (REST v3). */
export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: 1000, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? 'ededed' };
    }),
    user: { login: issue.user, type: 'User' },
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    comments: issue.comments.length,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    user: { login: comment.user, type: 'User' },
    created_at: comment.createdAt,
    updated_at: comment.createdAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}#issuecomment-${comment.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
  };
}

export function pullJson(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: pull.user, type: 'User' },
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    html_url: `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    draft: false,
  };
}
