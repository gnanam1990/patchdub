import type { IncomingMessage, ServerResponse } from 'node:http';
import { sha256 } from './util/hash.ts';
import type { DB } from './db.ts';

export const MAX_BODY_BYTES = 1_200_000;

export class ApiError extends Error {
  status: number;
  code: string;
  detail?: unknown;
  constructor(status: number, code: string, message: string, detail?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.detail = detail;
  }
}

export interface Actor {
  id: string;
  workspace_id: string;
  name: string;
  role: 'producer' | 'editor' | 'reviewer' | 'distributor' | 'operator';
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  db: DB;
  params: Record<string, string>;
  query: URLSearchParams;
  body: Record<string, unknown>;
  actor: Actor;
}

type Role = Actor['role'];
interface Route {
  method: string;
  pattern: string;
  roles: Role[] | 'any';
  handler: (ctx: Ctx) => Promise<unknown> | unknown;
}

export function json(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  res.end(payload);
}

export async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large', 'request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function patternToRegex(pattern: string): { regex: RegExp; keys: string[] } {
  const keys: string[] = [];
  const regex = new RegExp(
    '^' + pattern.replace(/\{([^}]+)\}/g, (_, k) => {
      keys.push(k);
      return '([^/]+)';
    }) + '$',
  );
  return { regex, keys };
}

export class Router {
  routes: { route: Route; regex: RegExp; keys: string[] }[] = [];

  add(method: string, pattern: string, roles: Role[] | 'any', handler: Route['handler']): void {
    const { regex, keys } = patternToRegex(pattern);
    this.routes.push({ route: { method, pattern, roles, handler }, regex, keys });
  }

  async dispatch(ctx: Omit<Ctx, 'params' | 'actor'> & { actor: Actor | null }): Promise<boolean> {
    const url = new URL(ctx.req.url ?? '/', 'http://localhost');
    const path = url.pathname;
    for (const { route, regex, keys } of this.routes) {
      if (route.method !== ctx.req.method) continue;
      const m = regex.exec(path);
      if (!m) continue;
      const params: Record<string, string> = {};
      keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      if (route.roles !== 'any') {
        if (!ctx.actor) throw new ApiError(401, 'unauthenticated', 'a workspace actor token is required');
        if (!route.roles.includes(ctx.actor.role)) {
          throw new ApiError(403, 'forbidden_role', `role ${ctx.actor.role} may not perform this action`);
        }
      }
      const result = await route.handler({ ...ctx, params, actor: ctx.actor as Actor });
      if (result !== undefined) json(ctx.res, 200, result);
      return true;
    }
    return false;
  }
}

export function authenticate(db: DB, req: IncomingMessage): Actor | null {
  const header = req.headers.authorization ?? '';
  const m = /^Bearer\s+(.+)$/.exec(header);
  if (!m) return null;
  const hash = sha256(m[1].trim());
  const row = db
    .prepare('SELECT id, workspace_id, name, role FROM actors WHERE token_hash = ?')
    .get(hash) as Actor | undefined;
  return row ?? null;
}

/** Verify the loaded resource belongs to the actor's workspace (tenant scope). */
export function requireSameWorkspace(actor: Actor, resourceWorkspaceId: string | null | undefined): void {
  if (!resourceWorkspaceId || resourceWorkspaceId !== actor.workspace_id) {
    throw new ApiError(404, 'not_found', 'resource not found');
  }
}

export function requireFields(body: Record<string, unknown>, fields: string[]): void {
  for (const f of fields) {
    if (body[f] === undefined || body[f] === null || body[f] === '') {
      throw new ApiError(400, 'missing_field', `field "${f}" is required`);
    }
  }
}

export function str(body: Record<string, unknown>, key: string): string {
  return String(body[key] ?? '');
}

export function int(body: Record<string, unknown>, key: string): number {
  const n = Number(body[key]);
  if (!Number.isFinite(n)) throw new ApiError(400, 'invalid_field', `field "${key}" must be a number`);
  return n;
}
