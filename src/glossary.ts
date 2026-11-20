import { id, now, glossaryDigest } from './util/hash.ts';
import { ApiError } from './http.ts';
import type { DB } from './db.ts';

export interface GlossaryTerm {
  source: string;
  target: string;
  required: boolean;
}

export function createGlossary(db: DB, workspaceId: string, name: string, rawTerms: unknown) {
  if (!Array.isArray(rawTerms)) throw new ApiError(400, 'invalid_terms', 'terms must be an array');
  const terms: GlossaryTerm[] = rawTerms.map((t) => {
    const term = t as Record<string, unknown>;
    if (!term.source || !term.target) throw new ApiError(400, 'invalid_terms', 'each term needs source and target');
    return { source: String(term.source), target: String(term.target), required: !!term.required };
  });
  const gid = id('glo');
  const digest = glossaryDigest(terms);
  db.prepare('INSERT INTO glossaries(id,workspace_id,name,digest,terms,created_at) VALUES (?,?,?,?,?,?)')
    .run(gid, workspaceId, name, digest, JSON.stringify(terms), now());
  return { id: gid, name, digest, terms };
}

export function listGlossaries(db: DB, workspaceId: string) {
  return (db.prepare('SELECT id,name,digest,terms,created_at FROM glossaries WHERE workspace_id = ? ORDER BY created_at')
    .all(workspaceId) as { terms: string }[]).map((g) => ({ ...g, terms: JSON.parse(g.terms) }));
}

export function loadGlossaryTerms(db: DB, glossaryId: string | null): GlossaryTerm[] {
  if (!glossaryId) return [];
  const row = db.prepare('SELECT terms FROM glossaries WHERE id = ?').get(glossaryId) as { terms: string } | undefined;
  return row ? (JSON.parse(row.terms) as GlossaryTerm[]) : [];
}
