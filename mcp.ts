// mcp.ts — the Model Context Protocol endpoint (JSON-RPC 2.0 Streamable HTTP) over the same Store
// REST and GraphQL use. Revision 2026-07-28 via `server/discover`, with the legacy `initialize` /
// `notifications/initialized` handshake as a fallback. Every tools/call answer carries both the
// text content blocks and the structuredContent the checks read.

import type { Store } from './store.ts';
import { issueJson, pullJson, repoJson } from './store.ts';
import { computeMergeable, squashMerge } from './merge.ts';
import { viewerUser } from './scenario.ts';

export const MCP_SERVER_NAME = 'github-core-clone';
export const MCP_SERVER_VERSION = '1.0.0';
export const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

interface ToolDef {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: {
    readonly type: 'object';
    readonly properties: Record<string, Record<string, unknown>>;
    readonly required: string[];
  };
}

const TOOLS: readonly ToolDef[] = Object.freeze([
  Object.freeze({
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  }),
  Object.freeze({
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  }),
  Object.freeze({
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by state: open, closed, or all.', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
    },
  }),
  Object.freeze({
    name: 'create_pull_request',
    description: 'Create a pull request in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch of the pull request.' },
        base: { type: 'string', description: 'The base branch of the pull request.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  }),
  Object.freeze({
    name: 'merge_pull_request',
    description: 'Merge a pull request in a repository.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'integer', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  }),
]);

/** The tools/list answer, built once so two calls are byte-identical. */
const TOOLS_LIST_JSON = JSON.stringify({ tools: TOOLS });

export function toolsListJson(): string {
  return TOOLS_LIST_JSON;
}

interface JsonRpcRequest {
  readonly jsonrpc?: unknown;
  readonly id?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

interface ToolResult {
  readonly content: Array<{ type: 'text'; text: string }>;
  readonly structuredContent?: unknown;
  readonly isError?: boolean;
}

function textResult(value: unknown): ToolResult {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return { content: [{ type: 'text', text }], structuredContent: value };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function pickString(args: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return undefined;
}

function pickNumber(args: Record<string, unknown>, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value === 'string' && /^\d+$/.test(value)) return Number(value);
  }
  return undefined;
}

/** Resolve owner/repo from the arguments, accepting a full_name fallback. */
function ownerRepo(args: Record<string, unknown>): { owner: string; repo: string } | null {
  let owner = pickString(args, 'owner', 'owner_login', 'org', 'organization', 'user', 'login', 'account', 'namespace', 'owner_name');
  let repo = pickString(args, 'repo', 'repository', 'repository_name', 'repo_name', 'repo_slug', 'project', 'project_name');
  if ((owner === undefined || repo === undefined) && typeof args.full_name === 'string') {
    const slash = args.full_name.indexOf('/');
    if (slash > 0) {
      owner ??= args.full_name.slice(0, slash);
      repo ??= args.full_name.slice(slash + 1);
    }
  }
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/** Run one tool against the store; returns the tool result (never throws for a known tool). */
export function callTool(store: Store, name: string, args: Record<string, unknown>): ToolResult {
  const normalized = name.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (normalized === 'createrepo') {
    const repoName = pickString(args, 'name', 'repo', 'repository', 'repository_name', 'repo_name');
    if (repoName === undefined) return errorResult('Missing required argument: name.');
    const description = pickString(args, 'description', 'about', 'summary', 'body') ?? '';
    const isPrivate = typeof args.private === 'boolean' ? args.private : args.private === 'true';
    const repo = store.createRepo(viewerUser().login, repoName, description, isPrivate);
    if (repo === null) return errorResult(`Repository ${viewerUser().login}/${repoName} already exists.`);
    return textResult(repoJson(repo));
  }
  if (normalized === 'getrepo') {
    const target = ownerRepo(args);
    if (target === null) return errorResult('Missing required arguments: owner and repo.');
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return errorResult(`Repository ${target.owner}/${target.repo} not found.`);
    return textResult(repoJson(repo));
  }
  if (normalized === 'createissue') {
    const target = ownerRepo(args);
    const title = pickString(args, 'title', 'issue_title', 'subject');
    if (target === null || title === undefined) return errorResult('Missing required arguments: owner, repo, and title.');
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return errorResult(`Repository ${target.owner}/${target.repo} not found.`);
    const body = pickString(args, 'body', 'issue_body', 'description', 'content', 'text') ?? '';
    const issue = store.createIssue(repo, title, body, []);
    return textResult(issueJson(repo, issue));
  }
  if (normalized === 'listissues') {
    const target = ownerRepo(args);
    if (target === null) return errorResult('Missing required arguments: owner and repo.');
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return errorResult(`Repository ${target.owner}/${target.repo} not found.`);
    const state = pickString(args, 'state', 'status');
    let issues = [...repo.issues.values()];
    if (state === 'open' || state === 'closed') issues = issues.filter((issue) => issue.state === state);
    const list = issues.map((issue) => issueJson(repo, issue));
    return { content: [{ type: 'text', text: JSON.stringify(list) }], structuredContent: { issues: list } };
  }
  if (normalized === 'createpullrequest') {
    const target = ownerRepo(args);
    const title = pickString(args, 'title', 'pr_title', 'pull_request_title', 'subject');
    const head = pickString(args, 'head', 'head_ref', 'head_branch', 'source', 'source_ref', 'source_branch', 'from', 'from_branch', 'branch');
    const base = pickString(args, 'base', 'base_ref', 'base_branch', 'target', 'target_ref', 'target_branch', 'into', 'into_branch');
    if (target === null || title === undefined || head === undefined || base === undefined) {
      return errorResult('Missing required arguments: owner, repo, title, head, and base.');
    }
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return errorResult(`Repository ${target.owner}/${target.repo} not found.`);
    const headSha = repo.refs.get(`refs/heads/${head}`);
    const baseSha = repo.refs.get(`refs/heads/${base}`);
    if (headSha === undefined) return errorResult(`Head branch ${head} does not exist.`);
    if (baseSha === undefined) return errorResult(`Base branch ${base} does not exist.`);
    const duplicate = [...repo.pulls.values()].find((pull) => pull.state === 'open' && pull.headRef === head && pull.baseRef === base);
    if (duplicate !== undefined) return errorResult('A pull request already exists for this head and base.');
    const body = pickString(args, 'body', 'description', 'content', 'text') ?? '';
    const pull = store.createPull(repo, title, body, head, base, headSha, baseSha);
    return textResult(pullJson(repo, pull));
  }
  if (normalized === 'mergepullrequest') {
    const target = ownerRepo(args);
    const pullNumber = pickNumber(args, 'pull_number', 'pull_request_number', 'pr_number', 'number', 'issue_number', 'index');
    if (target === null || pullNumber === undefined) return errorResult('Missing required arguments: owner, repo, and pull_number.');
    const repo = store.getRepo(target.owner, target.repo);
    if (repo === undefined) return errorResult(`Repository ${target.owner}/${target.repo} not found.`);
    const pull = repo.pulls.get(pullNumber);
    if (pull === undefined) return errorResult(`Pull request #${pullNumber} not found.`);
    if (pull.state !== 'open') return errorResult(`Pull request #${pullNumber} is not open.`);
    if (computeMergeable(repo, pull) === 'CONFLICTING') return errorResult(`Pull request #${pullNumber} has merge conflicts.`);
    const merged = squashMerge(repo, pull, () => store.nowSec());
    if (merged === null) return errorResult(`Pull request #${pullNumber} could not be merged.`);
    return textResult(pullJson(repo, pull));
  }
  return errorResult(`Unknown tool: ${name}`);
}

export interface McpOutcome {
  /** HTTP status to answer. */
  readonly status: number;
  /** JSON-RPC body to send, or null for an empty (notification) answer. */
  readonly body: Record<string, unknown> | null;
}

/** Handle one decoded JSON-RPC request object. */
export function handleMcpRequest(store: Store, request: JsonRpcRequest): McpOutcome {
  const id = request.id === undefined ? null : request.id;
  const isNotification = request.id === undefined;
  const method = typeof request.method === 'string' ? request.method : '';
  const params = (request.params ?? {}) as Record<string, unknown>;

  const result = (value: unknown): McpOutcome => ({
    status: 200,
    body: { jsonrpc: '2.0', id, result: value },
  });
  const error = (code: number, message: string): McpOutcome => ({
    status: 200,
    body: { jsonrpc: '2.0', id, error: { code, message } },
  });

  if (method === 'server/discover') {
    return result({
      supportedVersions: MCP_REVISIONS,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
      _meta: { 'io.modelcontextprotocol/serverInfo': { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION } },
    });
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const protocolVersion = MCP_REVISIONS.includes(requested) ? requested : '2025-11-25';
    return result({
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
    });
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    return { status: 202, body: null };
  }
  if (method === 'ping') {
    return result({});
  }
  if (method === 'tools/list') {
    // Byte-identical across calls: the list was stringified once at load.
    return { status: 200, body: { jsonrpc: '2.0', id, result: JSON.parse(TOOLS_LIST_JSON) } };
  }
  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments ?? {}) as Record<string, unknown>;
    const tool = TOOLS.find((entry) => entry.name === toolName || entry.name === toolName.toLowerCase().replace(/[^a-z0-9]/g, ''));
    const normalized = toolName.toLowerCase().replace(/[^a-z0-9]/g, '');
    const known = TOOLS.some((entry) => entry.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized);
    if (!known) return error(-32602, `Unknown tool: ${toolName}`);
    void tool;
    // Missing required arguments, checked against the tool's own inputSchema.
    const def = TOOLS.find((entry) => entry.name.toLowerCase().replace(/[^a-z0-9]/g, '') === normalized) as ToolDef;
    const missing = def.inputSchema.required.filter((key) => !(key in args) || args[key] === undefined || args[key] === null || args[key] === '');
    if (missing.length > 0) return error(-32602, `Missing required argument(s): ${missing.join(', ')}.`);
    const outcome = callTool(store, toolName, args);
    return result(outcome);
  }
  if (isNotification) return { status: 202, body: null };
  return error(-32601, `Method not found: ${method}`);
}

/** The JSON-RPC parse-error answer for a non-JSON body (HTTP 400). */
export function mcpParseError(): McpOutcome {
  return {
    status: 400,
    body: { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } },
  };
}
