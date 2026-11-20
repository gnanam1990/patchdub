// Bounded WebVTT parsing and serialization. Malformed input fails at a
// line-level error; nothing is persisted by the caller on parse failure.

export interface ParsedCue {
  cueId: string | null;
  startMs: number;
  endMs: number;
  text: string;
  line: number; // first line of the cue block in the source document
}

export class VttError extends Error {
  line: number;
  constructor(message: string, line: number) {
    super(message);
    this.name = 'VttError';
    this.line = line;
  }
}

export const MAX_CUES = 5000;
export const MAX_BYTES = 1_000_000;
export const MAX_CUE_TEXT = 10_000;

const TS_RE = /^(\d{2,}):([0-5]\d):([0-5]\d)\.(\d{3})$/;

export function parseTimestamp(raw: string): number | null {
  // Also accept mm:ss.mmm by normalizing to hh:mm:ss.mmm
  const short = /^([0-5]?\d):([0-5]\d)\.(\d{3})$/.exec(raw.trim());
  const m = TS_RE.exec(raw.trim());
  if (m) {
    return (+m[1]) * 3_600_000 + (+m[2]) * 60_000 + (+m[3]) * 1000 + +m[4];
  }
  if (short) {
    return (+short[1]) * 60_000 + (+short[2]) * 1000 + +short[3];
  }
  return null;
}

export function formatTimestamp(ms: number): string {
  if (!Number.isInteger(ms) || ms < 0) throw new VttError(`invalid ms ${ms}`, 0);
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const r = ms % 1000;
  const pad = (n: number, w: number) => String(n).padStart(w, '0');
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}.${pad(r, 3)}`;
}

/** Parse a WebVTT document. Throws VttError with a 1-based line number. */
export function parseVtt(content: string): ParsedCue[] {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_BYTES) throw new VttError(`document exceeds ${MAX_BYTES} bytes`, 1);
  const lines = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  let i = 0;
  // Skip BOM
  if (lines[0]?.startsWith('﻿')) lines[0] = lines[0].slice(1);
  if (!/^WEBVTT([ \t].*)?$/.test(lines[0] ?? '')) {
    throw new VttError('missing WEBVTT header', 1);
  }
  i = 1;
  // Skip header metadata until a blank line or the first cue block. A cue
  // starts where a line contains '-->' or the next line does.
  while (i < lines.length && lines[i].trim() !== '') {
    if (lines[i].includes('-->') || lines[i + 1]?.includes('-->')) break;
    i++;
  }
  const cues: ParsedCue[] = [];
  while (i < lines.length) {
    while (i < lines.length && lines[i].trim() === '') i++;
    if (i >= lines.length) break;
    // NOTE / STYLE / REGION blocks: skip until blank line or a cue start
    // (inert content; some writers omit the separating blank line).
    if (/^(NOTE|STYLE|REGION)/.test(lines[i])) {
      while (i < lines.length && lines[i].trim() !== '') {
        if (lines[i].includes('-->') || lines[i + 1]?.includes('-->')) break;
        i++;
      }
      continue;
    }
    let cueId: string | null = null;
    let timingLine = lines[i];
    const cueStartLine = i + 1;
    if (!timingLine.includes('-->')) {
      // Treat as cue identifier
      if (i + 1 >= lines.length) throw new VttError('truncated cue block', cueStartLine);
      cueId = timingLine.trim() || null;
      i++;
      timingLine = lines[i];
      if (!timingLine.includes('-->')) throw new VttError('expected cue timing line', i + 1);
    }
    const arrow = timingLine.split('-->');
    if (arrow.length !== 2) throw new VttError('malformed timing line', i + 1);
    const startToken = arrow[0].trim().split(/[ \t]/)[0];
    const endToken = arrow[1].trim().split(/[ \t]/)[0];
    const startMs = parseTimestamp(startToken);
    const endMs = parseTimestamp(endToken);
    if (startMs === null) throw new VttError(`malformed start timecode "${startToken}"`, i + 1);
    if (endMs === null) throw new VttError(`malformed end timecode "${endToken}"`, i + 1);
    if (endMs <= startMs) {
      throw new VttError(`cue ends before it starts (${formatTimestamp(startMs)} --> ${formatTimestamp(endMs)})`, i + 1);
    }
    i++;
    const textLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '') {
      textLines.push(lines[i]);
      i++;
    }
    const text = textLines.join('\n');
    if (text.length === 0) throw new VttError('cue has no text', cueStartLine);
    if (text.length > MAX_CUE_TEXT) throw new VttError('cue text too long', cueStartLine);
    if (cues.length >= MAX_CUES) throw new VttError(`document exceeds ${MAX_CUES} cues`, cueStartLine);
    cues.push({ cueId, startMs, endMs, text, line: cueStartLine });
  }
  if (cues.length === 0) throw new VttError('no cues found', 1);
  return cues;
}

/** Escape untrusted cue text for inert serialization (SECURITY.md). */
export function escapeCueText(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/--&gt;/g, '--＞'); // never emit a nested arrow
}

function escapeCueId(cueId: string): string {
  // Cue identifiers must not contain "-->", newline or whitespace-breaking chars.
  const safe = cueId.replace(/-->/g, '-&gt;').replace(/[\r\n\t]/g, ' ').trim();
  return safe;
}

export interface SerializeCue {
  cueId?: string | null;
  startMs: number;
  endMs: number;
  text: string;
}

export function serializeVtt(cues: SerializeCue[], note?: string): string {
  let header = 'WEBVTT\n';
  if (note) header += `NOTE ${note.replace(/[\r\n]+/g, ' ')}\n`;
  header += '\n';
  const body = cues.map((c) => {
    const head = c.cueId ? `${escapeCueId(c.cueId)}\n` : '';
    return `${head}${formatTimestamp(c.startMs)} --> ${formatTimestamp(c.endMs)}\n${escapeCueText(c.text)}`;
  });
  return header + body.join('\n\n') + '\n';
}
