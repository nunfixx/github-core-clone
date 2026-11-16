// graphql.ts — a small, strict GraphQL executor for the documents gh and github-mcp-server send.
// It is a parser + resolver, not a library: the schema is the fixed set of types the suite
// introspects and queries, and every mutation writes to the same Store REST and MCP use.
//
// Wire contract: unauthenticated calls never reach here (app.ts answers 401 first). A document
// with an unknown field answers HTTP 200 with an `errors` array naming the field. An unknown repo
// answers `data.repository` null with no errors. A JSON array body is a batch: one result per
// operation, in order.

import type { Issue, PullRequest, Repo, Store } from './store.ts';
import {
  commentGlobalId,
  decodeGlobalId,
  issueGlobalId,
  pullGlobalId,
  repoGlobalId,
} from './store.ts';
import { diffTrees, mergeBase, parseCommit } from './git.ts';
import { computeMergeable, squashMerge } from './merge.ts';
import { viewerUser } from './scenario.ts';

// ---------------------------------------------------------------- schema

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  Issue: ['id', 'number', 'title', 'body', 'state', 'author', 'createdAt', 'updatedAt', 'url', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'headRefName', 'baseRefName', 'mergeable', 'files', 'author', 'createdAt', 'updatedAt', 'url', 'headRefOid', 'baseRefOid'],
  User: ['id', 'login', 'name', 'email'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestChangedFileConnection: ['nodes', 'pageInfo'],
  PullRequestChangedFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  IssueCommentEdge: ['node', 'cursor'],
  IssueLabelConnection: ['nodes'],
  IssueLabel: ['name', 'color'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'id', 'prefix'],
};

const ENUM_VALUES: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- lexer

type Token =
  | { kind: 'name'; value: string }
  | { kind: 'int'; value: string }
  | { kind: 'float'; value: string }
  | { kind: 'string'; value: string }
  | { kind: 'punct'; value: string }
  | { kind: 'spread'; value: '...' };

function lex(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < input.length && input[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && input.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:!=$@'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let value = '';
      i += 1;
      while (i < input.length && input[i] !== '"') {
        if (input[i] === '\\' && i + 1 < input.length) {
          const esc = input[i + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          i += 2;
        } else {
          value += input[i] as string;
          i += 1;
        }
      }
      i += 1;
      tokens.push({ kind: 'string', value });
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      let isFloat = false;
      if (input[j] === '-') j += 1;
      while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      if (input[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      if (input[j] === 'e' || input[j] === 'E') {
        isFloat = true;
        j += 1;
        if (input[j] === '+' || input[j] === '-') j += 1;
        while (j < input.length && /[0-9]/.test(input[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: input.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < input.length && /[_A-Za-z0-9]/.test(input[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: input.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Record<string, Value> };

interface FieldNode {
  readonly kind: 'field';
  readonly alias: string | null;
  readonly name: string;
  readonly args: Record<string, Value>;
  readonly selection: SelectionNode[] | null;
}
interface InlineFragmentNode {
  readonly kind: 'inline';
  readonly typeCondition: string | null;
  readonly selection: SelectionNode[];
}
interface SpreadNode {
  readonly kind: 'spread';
  readonly name: string;
}
type SelectionNode = FieldNode | InlineFragmentNode | SpreadNode;

interface OperationNode {
  readonly kind: 'query' | 'mutation';
  readonly name: string | null;
  readonly varDefs: Record<string, Value | null>;
  readonly selection: SelectionNode[];
}

interface DocumentNode {
  readonly operations: OperationNode[];
  readonly fragments: Record<string, SelectionNode[]>;
}

class Parser {
  private pos = 0;
  private readonly tokens: Token[];

  constructor(tokens: Token[]) {
    this.tokens = tokens;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private next(): Token {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`expected ${JSON.stringify(value)} in GraphQL document`);
  }

  private acceptPunct(value: string): boolean {
    const token = this.peek();
    if (token !== undefined && token.kind === 'punct' && token.value === value) {
      this.pos += 1;
      return true;
    }
    return false;
  }

  private expectName(): string {
    const token = this.next();
    if (token.kind !== 'name') throw new Error('expected a name in GraphQL document');
    return token.value;
  }

  parseDocument(): DocumentNode {
    const operations: OperationNode[] = [];
    const fragments: Record<string, SelectionNode[]> = {};
    while (this.peek() !== undefined) {
      const token = this.peek() as Token;
      if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const name = this.expectName();
        this.expectName(); // 'on'
        this.expectName(); // type condition
        fragments[name] = this.parseSelectionSet();
        continue;
      }
      operations.push(this.parseOperation());
    }
    return { operations, fragments };
  }

  private parseOperation(): OperationNode {
    let kind: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    const token = this.peek();
    if (token !== undefined && token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
      kind = token.value as 'query' | 'mutation';
      this.next();
      const nextToken = this.peek();
      if (nextToken !== undefined && nextToken.kind === 'name') name = this.next().value as string;
    } else if (token !== undefined && token.kind === 'name') {
      name = this.next().value as string;
    }
    const varDefs: Record<string, Value | null> = {};
    if (this.acceptPunct('(')) {
      while (!this.acceptPunct(')')) {
        this.expectPunct('$');
        const varName = this.expectName();
        this.expectPunct(':');
        this.parseTypeName();
        if (this.acceptPunct('=')) varDefs[varName] = this.parseValue(true);
        else varDefs[varName] = null;
      }
    }
    const selection = this.parseSelectionSet();
    return { kind, name, varDefs, selection };
  }

  private parseTypeName(): void {
    if (this.acceptPunct('[')) {
      this.parseTypeName();
      this.expectPunct(']');
    } else {
      this.expectName();
    }
    this.acceptPunct('!');
  }

  private parseSelectionSet(): SelectionNode[] {
    this.expectPunct('{');
    const selections: SelectionNode[] = [];
    while (!this.acceptPunct('}')) {
      const token = this.peek();
      if (token === undefined) throw new Error('unexpected end of selection set');
      if (token.kind === 'spread') {
        this.next();
        const nextToken = this.peek();
        if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
          this.next();
          const typeCondition = this.expectName();
          selections.push({ kind: 'inline', typeCondition, selection: this.parseSelectionSet() });
        } else if (nextToken !== undefined && nextToken.kind === 'name') {
          selections.push({ kind: 'spread', name: this.next().value as string });
        } else {
          selections.push({ kind: 'inline', typeCondition: null, selection: this.parseSelectionSet() });
        }
        continue;
      }
      if (token.kind !== 'name') throw new Error('expected a field name in selection set');
      const first = this.next().value as string;
      let alias: string | null = null;
      let name = first;
      if (this.acceptPunct(':')) {
        alias = first;
        name = this.expectName();
      }
      const args: Record<string, Value> = {};
      if (this.acceptPunct('(')) {
        while (!this.acceptPunct(')')) {
          const argName = this.expectName();
          this.expectPunct(':');
          args[argName] = this.parseValue(false);
        }
      }
      // Directives (@...) are accepted and ignored.
      while (this.acceptPunct('@')) {
        this.expectName();
        if (this.acceptPunct('(')) {
          while (!this.acceptPunct(')')) {
            this.expectName();
            this.expectPunct(':');
            this.parseValue(false);
          }
        }
      }
      let selection: SelectionNode[] | null = null;
      const nextToken = this.peek();
      if (nextToken !== undefined && nextToken.kind === 'punct' && nextToken.value === '{') {
        selection = this.parseSelectionSet();
      }
      selections.push({ kind: 'field', alias, name, args, selection });
    }
    return selections;
  }

  private parseValue(isConst: boolean): Value {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') {
      if (isConst) throw new Error('variable in a constant value');
      return { kind: 'var', name: this.expectName() };
    }
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'int') return { kind: 'int', value: Number.parseInt(token.value, 10) };
    if (token.kind === 'float') return { kind: 'float', value: Number.parseFloat(token.value) };
    if (token.kind === 'punct' && token.value === '[') {
      const items: Value[] = [];
      while (!this.acceptPunct(']')) items.push(this.parseValue(isConst));
      return { kind: 'list', items };
    }
    if (token.kind === 'punct' && token.value === '{') {
      const fields: Record<string, Value> = {};
      while (!this.acceptPunct('}')) {
        const name = this.expectName();
        this.expectPunct(':');
        fields[name] = this.parseValue(isConst);
      }
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    throw new Error('unexpected value in GraphQL document');
  }
}

// ---------------------------------------------------------------- execution

interface GqlValue {
  readonly __type: string;
  readonly [key: string]: unknown;
}

function wrap(type: string, value: Record<string, unknown>): GqlValue {
  return { __type: type, ...value };
}

function repoValue(repo: Repo): GqlValue {
  return wrap('Repository', { repo });
}

function issueValue(repo: Repo, issue: Issue): GqlValue {
  return wrap('Issue', { repo, issue });
}

function pullValue(repo: Repo, pull: PullRequest): GqlValue {
  return wrap('PullRequest', { repo, pull });
}

function userValue(login: string, id: number, name: string, email: string): GqlValue {
  return wrap('User', { login, id, name, email });
}

function encodeCursor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function decodeCursor(cursor: unknown): number | null {
  if (typeof cursor !== 'string') return null;
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    if (!text.startsWith('cursor:')) return null;
    const number = Number.parseInt(text.slice(7), 10);
    return Number.isFinite(number) ? number : null;
  } catch {
    return null;
  }
}

function resolveValue(value: Value, variables: Record<string, unknown>, varDefs: Record<string, Value | null>): unknown {
  switch (value.kind) {
    case 'var': {
      if (value.name in variables) return variables[value.name];
      const def = varDefs[value.name];
      return def === undefined || def === null ? null : resolveValue(def, variables, varDefs);
    }
    case 'string':
    case 'int':
    case 'float':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, variables, varDefs));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, entry] of Object.entries(value.fields)) out[key] = resolveValue(entry, variables, varDefs);
      return out;
    }
  }
}

function argsOf(field: FieldNode, variables: Record<string, unknown>, varDefs: Record<string, Value | null>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(field.args)) out[key] = resolveValue(value, variables, varDefs);
  return out;
}

class Executor {
  private readonly errors: Array<{ message: string }> = [];
  private readonly store: Store;
  private readonly variables: Record<string, unknown>;
  private readonly varDefs: Record<string, Value | null>;
  private readonly fragments: Record<string, SelectionNode[]>;

  constructor(
    store: Store,
    variables: Record<string, unknown>,
    varDefs: Record<string, Value | null>,
    fragments: Record<string, SelectionNode[]>,
  ) {
    this.store = store;
    this.variables = variables;
    this.varDefs = varDefs;
    this.fragments = fragments;
  }

  getErrors(): Array<{ message: string }> {
    return this.errors;
  }

  executeOperation(operation: OperationNode): Record<string, unknown> {
    const rootType = operation.kind === 'mutation' ? 'Mutation' : 'Query';
    const root: GqlValue = wrap(rootType, {});
    return this.resolveSelection(root, operation.selection) as Record<string, unknown>;
  }

  private resolveSelection(parent: GqlValue, selections: SelectionNode[]): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const selection of selections) {
      if (selection.kind === 'spread') {
        const fragment = this.fragments[selection.name];
        if (fragment === undefined) {
          this.errors.push({ message: `Unknown fragment "${selection.name}".` });
          continue;
        }
        Object.assign(out, this.resolveSelection(parent, fragment));
        continue;
      }
      if (selection.kind === 'inline') {
        if (selection.typeCondition !== null && selection.typeCondition !== parent.__type) continue;
        Object.assign(out, this.resolveSelection(parent, selection.selection));
        continue;
      }
      const key = selection.alias ?? selection.name;
      out[key] = this.resolveField(parent, selection);
    }
    return out;
  }

  private resolveField(parent: GqlValue, field: FieldNode): unknown {
    const typeName = parent.__type;
    if (field.name === '__typename') return typeName;
    // Introspection roots are valid on every type.
    if (field.name === '__type' || field.name === '__schema') {
      const args = argsOf(field, this.variables, this.varDefs);
      if (field.name === '__type') {
        const typeNameArg = String(args.name ?? '');
        if (TYPE_FIELDS[typeNameArg] !== undefined || ENUM_VALUES[typeNameArg] !== undefined) {
          const value = wrap('__Type', { typeName: typeNameArg });
          return field.selection === null ? value : this.resolveSelection(value, field.selection);
        }
        return null;
      }
      const schema = wrap('__Schema', {});
      return field.selection === null ? schema : this.resolveSelection(schema, field.selection);
    }
    const known = TYPE_FIELDS[typeName];
    if (known !== undefined && !known.includes(field.name)) {
      this.errors.push({ message: `Cannot query field "${field.name}" on type "${typeName}".` });
      return null;
    }
    const args = argsOf(field, this.variables, this.varDefs);
    let value: unknown;
    try {
      value = this.fieldValue(parent, field.name, args);
    } catch (error) {
      this.errors.push({ message: error instanceof Error ? error.message : String(error) });
      return null;
    }
    if (field.selection === null || value === null || value === undefined) return value;
    if (Array.isArray(value)) {
      return value.map((entry) => {
        if (entry !== null && typeof entry === 'object' && '__type' in (entry as Record<string, unknown>)) {
          return this.resolveSelection(entry as GqlValue, field.selection as SelectionNode[]);
        }
        return entry;
      });
    }
    if (typeof value === 'object' && '__type' in (value as Record<string, unknown>)) {
      return this.resolveSelection(value as GqlValue, field.selection);
    }
    return value;
  }

  private fieldValue(parent: GqlValue, name: string, args: Record<string, unknown>): unknown {
    switch (parent.__type) {
      case 'Query':
        return this.queryField(name, args);
      case 'Mutation':
        return this.mutationField(name, args);
      case 'Repository':
        return this.repositoryField(parent.repo as Repo, name, args);
      case 'Issue':
        return this.issueField(parent.repo as Repo, parent.issue as Issue, name, args);
      case 'PullRequest':
        return this.pullField(parent.repo as Repo, parent.pull as PullRequest, name, args);
      case 'User':
        return this.userField(parent, name);
      case 'IssueConnection':
      case 'PullRequestConnection':
      case 'PullRequestChangedFileConnection':
        return this.connectionField(parent, name);
      case 'PullRequestChangedFile':
        return (parent as unknown as Record<string, unknown>)[name] ?? null;
      case 'IssueComment':
        return this.commentField(parent, name);
      case 'IssueCommentEdge':
        return name === 'node' ? (parent as unknown as Record<string, unknown>).node : (parent as unknown as Record<string, unknown>).cursor;
      case 'IssueLabelConnection':
        return name === 'nodes' ? (parent as unknown as Record<string, unknown>).nodes : null;
      case 'IssueLabel':
        return (parent as unknown as Record<string, unknown>)[name] ?? null;
      case 'PageInfo':
        return (parent as unknown as Record<string, unknown>)[name] ?? null;
      case 'Ref':
        return (parent as unknown as Record<string, unknown>)[name] ?? null;
      case '__Type':
        return this.introspectionField(parent, name, args);
      case '__Field':
        return (parent as unknown as Record<string, unknown>)[name] ?? null;
      case '__EnumValue':
        return (parent as unknown as Record<string, unknown>)[name] ?? null;
      case '__Schema':
        return this.schemaField(parent, name);
      default:
        // Mutation payloads (CreateIssuePayload, ...) carry their fields as plain properties.
        return (parent as unknown as Record<string, unknown>)[name] ?? null;
    }
  }

  // ------------------------------------------------------------ Query

  private queryField(name: string, args: Record<string, unknown>): unknown {
    if (name === 'viewer') {
      const viewer = viewerUser();
      return userValue(viewer.login, viewer.id, viewer.name, viewer.email);
    }
    if (name === 'repository') {
      const repo = this.store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
      return repo === undefined ? null : repoValue(repo);
    }
    if (name === 'node') {
      return this.nodeValue(String(args.id ?? ''));
    }
    if (name === '__type') {
      const typeName = String(args.name ?? '');
      if (TYPE_FIELDS[typeName] !== undefined || ENUM_VALUES[typeName] !== undefined) {
        return wrap('__Type', { typeName });
      }
      return null;
    }
    if (name === '__schema') {
      return wrap('__Schema', {});
    }
    return null;
  }

  private nodeValue(id: string): GqlValue | null {
    const decoded = decodeGlobalId(id);
    if (decoded === null) return null;
    if (decoded.kind === 'Repository') {
      const repo = this.store.getRepoById(Number(decoded.parts[0]));
      return repo === undefined ? null : repoValue(repo);
    }
    if (decoded.kind === 'Issue') {
      const repo = this.store.getRepoById(Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      return repo === undefined || issue === undefined ? null : issueValue(repo, issue);
    }
    if (decoded.kind === 'PullRequest') {
      const repo = this.store.getRepoById(Number(decoded.parts[0]));
      const pull = repo?.pulls.get(Number(decoded.parts[1]));
      return repo === undefined || pull === undefined ? null : pullValue(repo, pull);
    }
    if (decoded.kind === 'IssueComment') {
      const repo = this.store.getRepoById(Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      const comment = issue?.comments.find((entry) => entry.id === Number(decoded.parts[2]));
      if (repo === undefined || issue === undefined || comment === undefined) return null;
      return wrap('IssueComment', { repo, issue, comment });
    }
    return null;
  }

  // ------------------------------------------------------------ Mutation

  private resolveRepoById(id: unknown): Repo | null {
    if (typeof id === 'number') return this.store.getRepoById(id) ?? null;
    const text = String(id ?? '');
    const asNumber = Number.parseInt(text, 10);
    if (String(asNumber) === text) {
      const byNumber = this.store.getRepoById(asNumber);
      if (byNumber !== undefined) return byNumber;
    }
    const decoded = decodeGlobalId(text);
    if (decoded !== null && decoded.kind === 'Repository') {
      return this.store.getRepoById(Number(decoded.parts[0])) ?? null;
    }
    return null;
  }

  private mutationField(name: string, args: Record<string, unknown>): unknown {
    const input = (args.input ?? {}) as Record<string, unknown>;
    if (name === 'createIssue') {
      const repo = this.resolveRepoById(input.repositoryId);
      if (repo === null) throw new Error('Could not resolve to a Repository with the id provided.');
      const issue = this.store.createIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
      return wrap('CreateIssuePayload', { issue: issueValue(repo, issue) });
    }
    if (name === 'closeIssue') {
      const decoded = decodeGlobalId(String(input.issueId ?? ''));
      if (decoded === null || decoded.kind !== 'Issue') throw new Error('Could not resolve to an Issue with the id provided.');
      const repo = this.store.getRepoById(Number(decoded.parts[0]));
      const issue = repo?.issues.get(Number(decoded.parts[1]));
      if (repo === undefined || issue === undefined) throw new Error('Could not resolve to an Issue with the id provided.');
      issue.state = 'closed';
      issue.updatedAt = this.store.nowIso();
      return wrap('CloseIssuePayload', { issue: issueValue(repo, issue) });
    }
    if (name === 'createPullRequest') {
      const repo = this.resolveRepoById(input.repositoryId);
      if (repo === null) throw new Error('Could not resolve to a Repository with the id provided.');
      const headRef = String(input.headRefName ?? '');
      const baseRef = String(input.baseRefName ?? '');
      const headSha = repo.refs.get(`refs/heads/${headRef}`);
      const baseSha = repo.refs.get(`refs/heads/${baseRef}`);
      if (headSha === undefined) throw new Error(`Head branch ${JSON.stringify(headRef)} does not exist.`);
      if (baseSha === undefined) throw new Error(`Base branch ${JSON.stringify(baseRef)} does not exist.`);
      const duplicate = [...repo.pulls.values()].find(
        (pull) => pull.state === 'open' && pull.headRef === headRef && pull.baseRef === baseRef,
      );
      if (duplicate !== undefined) throw new Error('A pull request already exists for this head and base.');
      const pull = this.store.createPull(repo, String(input.title ?? ''), String(input.body ?? ''), headRef, baseRef, headSha, baseSha);
      return wrap('CreatePullRequestPayload', { pullRequest: pullValue(repo, pull) });
    }
    if (name === 'mergePullRequest') {
      const decoded = decodeGlobalId(String(input.pullRequestId ?? ''));
      if (decoded === null || decoded.kind !== 'PullRequest') throw new Error('Could not resolve to a PullRequest with the id provided.');
      const repo = this.store.getRepoById(Number(decoded.parts[0]));
      const pull = repo?.pulls.get(Number(decoded.parts[1]));
      if (repo === undefined || pull === undefined) throw new Error('Could not resolve to a PullRequest with the id provided.');
      if (computeMergeable(repo, pull) === 'CONFLICTING') throw new Error('Pull request is not mergeable.');
      const merged = squashMerge(repo, pull, () => this.store.nowSec());
      if (merged === null) throw new Error('Pull request could not be merged.');
      return wrap('MergePullRequestPayload', { pullRequest: pullValue(repo, pull) });
    }
    if (name === 'addComment') {
      const decoded = decodeGlobalId(String(input.subjectId ?? ''));
      if (decoded === null) throw new Error('Could not resolve to a subject with the id provided.');
      let repo: Repo | undefined;
      let issue: Issue | undefined;
      if (decoded.kind === 'Issue') {
        repo = this.store.getRepoById(Number(decoded.parts[0]));
        issue = repo?.issues.get(Number(decoded.parts[1]));
      }
      if (repo === undefined || issue === undefined) throw new Error('Could not resolve to a subject with the id provided.');
      const comment = this.store.addComment(repo, issue, String(input.body ?? ''));
      const node = wrap('IssueComment', { repo, issue, comment });
      return wrap('AddCommentPayload', {
        commentEdge: wrap('IssueCommentEdge', { node, cursor: encodeCursor(comment.id) }),
      });
    }
    return null;
  }

  // ------------------------------------------------------------ Repository

  private repositoryField(repo: Repo, name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'id':
        return repoGlobalId(repo.id);
      case 'databaseId':
        return repo.id;
      case 'name':
        return repo.name;
      case 'nameWithOwner':
        return `${repo.owner}/${repo.name}`;
      case 'owner': {
        return userValue(repo.owner, 1000, repo.owner, `${repo.owner}@example.invalid`);
      }
      case 'defaultBranchRef': {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        if (tip === undefined) return null;
        return wrap('Ref', { name: repo.defaultBranch, id: repoGlobalId(repo.id), prefix: 'refs/heads/' });
      }
      case 'viewerPermission':
        return 'ADMIN';
      case 'hasIssuesEnabled':
        return true;
      case 'description':
        return repo.description;
      case 'isPrivate':
        return repo.isPrivate;
      case 'createdAt':
        return repo.createdAt;
      case 'updatedAt':
        return repo.updatedAt;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}`;
      case 'issue': {
        const issue = repo.issues.get(Number(args.number));
        return issue === undefined ? null : issueValue(repo, issue);
      }
      case 'issues':
        return this.issueConnection(repo, args);
      case 'pullRequests':
        return this.pullConnection(repo, args);
      case 'pullRequest': {
        const pull = repo.pulls.get(Number(args.number));
        return pull === undefined ? null : pullValue(repo, pull);
      }
      default:
        return null;
    }
  }

  private issueConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
    let issues = [...repo.issues.values()];
    const states = args.states as string[] | undefined;
    if (Array.isArray(states) && states.length > 0) {
      const wanted = new Set(states.map((state) => String(state).toLowerCase()));
      issues = issues.filter((issue) => wanted.has(issue.state));
    }
    const orderBy = (args.orderBy ?? {}) as Record<string, unknown>;
    const direction = String(orderBy.direction ?? 'ASC');
    const field = String(orderBy.field ?? 'CREATED_AT');
    if (field === 'CREATED_AT' && direction === 'DESC') issues.sort((a, b) => b.number - a.number);
    else if (field === 'CREATED_AT') issues.sort((a, b) => a.number - b.number);
    else if (direction === 'DESC') issues.sort((a, b) => b.number - a.number);
    else issues.sort((a, b) => a.number - b.number);
    return this.paginate(
      issues.map((issue) => issueValue(repo, issue)),
      issues.map((issue) => issue.number),
      args,
      'IssueConnection',
    );
  }

  private pullConnection(repo: Repo, args: Record<string, unknown>): GqlValue {
    const pulls = [...repo.pulls.values()].sort((a, b) => a.number - b.number);
    return this.paginate(
      pulls.map((pull) => pullValue(repo, pull)),
      pulls.map((pull) => pull.number),
      args,
      'PullRequestConnection',
    );
  }

  private paginate(nodes: GqlValue[], numbers: number[], args: Record<string, unknown>, type: string): GqlValue {
    const first = typeof args.first === 'number' ? args.first : undefined;
    const after = decodeCursor(args.after);
    let start = 0;
    if (after !== null) {
      const index = numbers.indexOf(after);
      start = index >= 0 ? index + 1 : 0;
    }
    const sliced = first === undefined ? nodes.slice(start) : nodes.slice(start, start + first);
    const slicedNumbers = first === undefined ? numbers.slice(start) : numbers.slice(start, start + first);
    const hasNextPage = start + sliced.length < nodes.length;
    const endCursor = slicedNumbers.length > 0 ? encodeCursor(slicedNumbers[slicedNumbers.length - 1] as number) : null;
    const startCursor = slicedNumbers.length > 0 ? encodeCursor(slicedNumbers[0] as number) : null;
    return wrap(type, {
      nodes: sliced,
      pageInfo: wrap('PageInfo', { hasNextPage, hasPreviousPage: start > 0, startCursor, endCursor }),
      totalCount: nodes.length,
    });
  }

  // ------------------------------------------------------------ Issue

  private issueField(repo: Repo, issue: Issue, name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'id':
        return issueGlobalId(repo.id, issue.number);
      case 'number':
        return issue.number;
      case 'title':
        return issue.title;
      case 'body':
        return issue.body;
      case 'state':
        return issue.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'author':
        return userValue(issue.user, 1000, issue.user, `${issue.user}@example.invalid`);
      case 'createdAt':
        return issue.createdAt;
      case 'updatedAt':
        return issue.updatedAt;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/issues/${issue.number}`;
      case 'labels':
        return wrap('IssueLabelConnection', {
          nodes: issue.labels.map((labelName) => wrap('IssueLabel', { name: labelName, color: repo.labels.get(labelName)?.color ?? 'ededed' })),
        });
      case 'comments': {
        const nodes = issue.comments.map((comment) => wrap('IssueComment', { repo, issue, comment }));
        return wrap('IssueConnection', {
          nodes,
          pageInfo: wrap('PageInfo', { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }),
          totalCount: nodes.length,
        });
      }
      default:
        return null;
    }
  }

  // ------------------------------------------------------------ PullRequest

  private pullField(repo: Repo, pull: PullRequest, name: string, args: Record<string, unknown>): unknown {
    switch (name) {
      case 'id':
        return pullGlobalId(repo.id, pull.number);
      case 'number':
        return pull.number;
      case 'title':
        return pull.title;
      case 'body':
        return pull.body;
      case 'state':
        return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
      case 'merged':
        return pull.merged;
      case 'mergedAt':
        return pull.mergedAt;
      case 'headRefName':
        return pull.headRef;
      case 'baseRefName':
        return pull.baseRef;
      case 'headRefOid':
        return pull.headSha;
      case 'baseRefOid':
        return pull.baseSha;
      case 'mergeable':
        return computeMergeable(repo, pull);
      case 'author':
        return userValue(pull.user, 1000, pull.user, `${pull.user}@example.invalid`);
      case 'createdAt':
        return pull.createdAt;
      case 'updatedAt':
        return pull.updatedAt;
      case 'url':
        return `https://example.invalid/${repo.owner}/${repo.name}/pull/${pull.number}`;
      case 'files':
        return this.pullFiles(repo, pull, args);
      default:
        return null;
    }
  }

  private pullFiles(repo: Repo, pull: PullRequest, args: Record<string, unknown>): GqlValue {
    const base = mergeBase(repo.objects, pull.headSha, pull.baseSha);
    const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
    const headTree = parseCommit(repo.objects.get(pull.headSha)?.data ?? Buffer.alloc(0)).tree;
    const diffs = diffTrees(repo.objects, baseTree, headTree);
    const nodes = diffs.map((diff) => {
      let additions = 0;
      let deletions = 0;
      if (diff.status === 'added' && diff.newOid !== null) {
        additions = lineCount(repo, diff.newOid);
      } else if (diff.status === 'removed' && diff.oldOid !== null) {
        deletions = lineCount(repo, diff.oldOid);
      } else if (diff.oldOid !== null && diff.newOid !== null) {
        const counts = lineDiff(repo, diff.oldOid, diff.newOid);
        additions = counts.additions;
        deletions = counts.deletions;
      }
      return wrap('PullRequestChangedFile', {
        path: diff.path,
        status: diff.status.toUpperCase(),
        additions,
        deletions,
        changes: additions + deletions,
      });
    });
    const first = typeof args.first === 'number' ? args.first : undefined;
    const sliced = first === undefined ? nodes : nodes.slice(0, first);
    return wrap('PullRequestChangedFileConnection', {
      nodes: sliced,
      pageInfo: wrap('PageInfo', {
        hasNextPage: first !== undefined && nodes.length > first,
        hasPreviousPage: false,
        startCursor: null,
        endCursor: null,
      }),
    });
  }

  // ------------------------------------------------------------ User / comment

  private userField(parent: GqlValue, name: string): unknown {
    if (name === 'id') return Buffer.from(`User:${parent.id as number}`, 'utf8').toString('base64');
    return (parent as unknown as Record<string, unknown>)[name] ?? null;
  }

  private commentField(parent: GqlValue, name: string): unknown {
    const comment = parent.comment as { id: number; body: string; user: string; createdAt: string };
    const repo = parent.repo as Repo;
    const issue = parent.issue as Issue;
    if (name === 'id') return commentGlobalId(repo.id, issue.number, comment.id);
    if (name === 'body') return comment.body;
    if (name === 'author') return userValue(comment.user, 1000, comment.user, `${comment.user}@example.invalid`);
    if (name === 'createdAt') return comment.createdAt;
    return null;
  }

  // ------------------------------------------------------------ connections / introspection

  private connectionField(parent: GqlValue, name: string): unknown {
    return (parent as unknown as Record<string, unknown>)[name] ?? null;
  }

  private introspectionField(parent: GqlValue, name: string, args: Record<string, unknown>): unknown {
    const typeName = parent.typeName as string;
    if (name === 'name') return typeName;
    if (name === 'kind') return ENUM_VALUES[typeName] !== undefined ? 'ENUM' : 'OBJECT';
    if (name === 'description') return null;
    if (name === 'fields') {
      const fields = TYPE_FIELDS[typeName] ?? [];
      return fields.map((fieldName) => wrap('__Field', { name: fieldName, description: null, type: wrap('__Type', { typeName: 'String' }) }));
    }
    if (name === 'enumValues') {
      const values = ENUM_VALUES[typeName] ?? [];
      return values.map((value) => wrap('__EnumValue', { name: value, description: null }));
    }
    return null;
  }

  private schemaField(parent: GqlValue, name: string): unknown {
    if (name === 'queryType') return wrap('__Type', { typeName: 'Query' });
    if (name === 'mutationType') return wrap('__Type', { typeName: 'Mutation' });
    if (name === 'types') {
      return [...Object.keys(TYPE_FIELDS), ...Object.keys(ENUM_VALUES)].map((typeName) => wrap('__Type', { typeName }));
    }
    return null;
  }
}

function lineCount(repo: Repo, oid: string): number {
  const object = repo.objects.get(oid);
  if (object === undefined) return 0;
  const text = object.data.toString('utf8');
  if (text === '') return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

function lineDiff(repo: Repo, oldOid: string, newOid: string): { additions: number; deletions: number } {
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

// ---------------------------------------------------------------- entry points

export interface GraphQLResult {
  readonly data?: Record<string, unknown> | null;
  readonly errors?: Array<{ message: string }>;
}

/** Execute one operation document against the store. */
export function executeGraphQL(store: Store, query: string, variables: Record<string, unknown>): GraphQLResult {
  let document: DocumentNode;
  try {
    document = new Parser(lex(query)).parseDocument();
  } catch (error) {
    return { data: null, errors: [{ message: error instanceof Error ? error.message : String(error) }] };
  }
  const operation = document.operations[0];
  if (operation === undefined) {
    return { data: null, errors: [{ message: 'No operation in GraphQL document.' }] };
  }
  const executor = new Executor(store, variables, operation.varDefs, document.fragments);
  const data = executor.executeOperation(operation);
  const errors = executor.getErrors();
  return errors.length > 0 ? { data, errors } : { data };
}

/** Execute a batch (JSON array of operations) in order; a single object is one operation. */
export function executeGraphQLBatch(store: Store, body: unknown): GraphQLResult | GraphQLResult[] {
  if (Array.isArray(body)) {
    return body.map((entry) => {
      const record = (entry ?? {}) as Record<string, unknown>;
      return executeGraphQL(store, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>);
    });
  }
  const record = (body ?? {}) as Record<string, unknown>;
  return executeGraphQL(store, String(record.query ?? ''), (record.variables ?? {}) as Record<string, unknown>);
}
