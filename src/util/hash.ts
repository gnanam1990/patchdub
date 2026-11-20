import { createHash, randomBytes, randomUUID } from 'node:crypto';

export function sha256(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex');
}

export function id(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 24)}`;
}

export function token(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString('hex')}`;
}

export function now(): string {
  return new Date().toISOString();
}

/** Canonical digest for a patch variant: normalized whitespace, NFC text. */
export function variantDigest(text: string): string {
  return sha256(text.normalize('NFC').replace(/\r\n/g, '\n').trim());
}

/** Canonical digest for a glossary: terms sorted and serialized deterministically. */
export function glossaryDigest(terms: { source: string; target: string; required: boolean }[]): string {
  const canon = terms
    .map((t) => ({ s: t.source.normalize('NFC'), t: t.target.normalize('NFC'), r: !!t.required }))
    .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  return sha256(JSON.stringify(canon));
}
