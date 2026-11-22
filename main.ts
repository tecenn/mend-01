// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone.
// Run it as `node main.ts [options] [PATCH]`. In a trial it hands over to runner.ts.
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class ParseFail extends Error {
  line: string;
  constructor(line: string) { super(line); this.line = line; }
}
class EditFail extends Error {
  code: string; path: string;
  constructor(code: string, path: string) { super(code); this.code = code; this.path = path; }
}

const isBlank = (s: string): boolean => s.trim() === '';
const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => { const m = /^[ \t]*/.exec(s); return m ? m[0] : ''; };
const cmpBuf = (a: string, b: string): number => Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));

function splitPatch(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function isSafe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

interface FileModel { lines: string[]; br: '\r\n' | '\n'; final: boolean; }
function parseFile(text: string): FileModel {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}
function renderFile(f: FileModel): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

class Tree {
  private orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try { if (statSync(p).isFile()) v = readFileSync(p, 'utf8'); } catch { v = null; }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type EditFn = (t: Tree, strict: boolean) => void;
let movePairs: Array<[string, string]> = [];

// ---- section 5: matching lines ----
function tierEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return rstrip(a) === rstrip(b);
  return stripWs(a) === stripWs(b);
}
function occAt(o: string[], lines: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (o.length === 0) return out;
  for (let i = from; i + o.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < o.length; j++) if (!tierEq(o[j]!, lines[i + j]!, tier)) { ok = false; break; }
    if (ok) out.push(i);
  }
  return out;
}
function firstTier(o: string[], lines: string[], strict: boolean, from: number): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occAt(o, lines, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}
// N line: { t: text, o: index into O for a context line, -1 for a new line }.
interface NLine { t: string; o: number; }
function buildRepl(fileLines: string[], at: number, o: string[], n: NLine[], tier: number): string[] {
  const hasO = o.length > 0;
  const f = tier === 2 && hasO ? leadWs(fileLines[at]!) : '';
  const p = tier === 2 && hasO ? leadWs(o[0]!) : '';
  return n.map((nl) => {
    if (nl.o >= 0) return fileLines[at + nl.o]!;
    if (tier === 2 && nl.t !== '' && nl.t.trim() !== '' && nl.t.startsWith(p)) return f + nl.t.slice(p.length);
    return nl.t;
  });
}

// ---- section 4: format detection ----
function detectFormat(lines: string[]): string | null {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---- section 1: arguments ----
interface Cli { format: string; check: boolean; strict: boolean; patch: string | null; }
function parseArgs(args: string[]): Cli | null {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') { ended = true; continue; }
    if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return null;
    } else pos.push(a);
  }
  if (pos.length > 1) return null;
  return { format: format ?? 'auto', check, strict, patch: pos.length === 0 || pos[0] === '-' ? null : pos[0]! };
}

// ---- section 9: JSON edits ----
function jsonEdit(v: unknown): EditFn | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const need = (tree: Tree): string => {
    if (!isSafe(p)) throw new EditFail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new EditFail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = need(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const norm = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = norm(before);
      const old = norm(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new EditFail('no-match', p);
      if (count > 1) throw new EditFail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + norm(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = splitPatch(o.new_str);
    return (tree) => {
      const before = need(tree);
      const model = parseFile(before);
      if (line < 0 || line > model.lines.length) throw new EditFail('no-match', p);
      model.lines.splice(line, 0, ...add);
      tree.now.set(p, renderFile(model));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  const edits: EditFn[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try { v = JSON.parse(text); } catch { throw new ParseFail(`error: parse ${first + 1}`); }
    if (!Array.isArray(v)) throw new ParseFail(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new ParseFail(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (isBlank(l)) return;
    let e: EditFn | null = null;
    try { e = jsonEdit(JSON.parse(l)); } catch { e = null; }
    if (e === null) throw new ParseFail(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---- section 7: SEARCH/REPLACE blocks ----
function srEdit(path: string, oldLines: string[], newLines: string[]): EditFn {
  return (tree, strict) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new EditFail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const cur = tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    const model = parseFile(cur);
    const found = firstTier(oldLines, model.lines, strict, 0);
    if (!found) throw new EditFail('no-match', path);
    if (found.pos.length > 1) throw new EditFail('ambiguous', path);
    const at = found.pos[0]!;
    const n: NLine[] = newLines.map((t) => ({ t, o: -1 }));
    const repl = buildRepl(model.lines, at, oldLines, n, found.tier);
    const out = [...model.lines];
    out.splice(at, oldLines.length, ...repl);
    tree.now.set(path, renderFile({ lines: out, br: model.br, final: model.final }));
  };
}

function srEdits(lines: string[]): EditFn[] {
  const edits: EditFn[] = [];
  let prevPath: string | null = null;
  let prevEnd = -1;
  let i = 0;
  while (i < lines.length) {
    const s = lines.findIndex((l, k) => k >= i && l.trimEnd() === '<<<<<<< SEARCH');
    if (s < 0) break;
    let path: string | null = null;
    for (let j = s - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '' || t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath !== null) path = prevPath;
      else throw new ParseFail(`error: parse ${s + 1}`);
    }
    let eq = -1;
    for (let j = s + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '=======') { eq = j; break; }
    }
    if (eq < 0) throw new ParseFail(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') break;
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') { rep = j; break; }
    }
    if (rep < 0) throw new ParseFail(`error: parse ${s + 1}`);
    edits.push(srEdit(path, lines.slice(s + 1, eq), lines.slice(eq + 1, rep)));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

// ---- section 6: unified diffs ----
interface Hunk { a: number; o: string[]; n: NLine[]; noEol: boolean; plusNoEol: boolean; }
interface RawSection {
  dash: string | null | undefined; plus: string | null | undefined;
  renameFrom: string | undefined; renameTo: string | undefined;
  diffX: string | undefined; diffY: string | undefined;
  create: boolean; del: boolean; hunks: Hunk[];
}
function finishHunk(raw: string[], a: number): Hunk {
  let noEol = false;
  let plusNoEol = false;
  let lastCtxPlus = -1;
  let lastPlus = -1;
  for (let k = 0; k < raw.length; k++) {
    const l = raw[k]!;
    if (l === '' || l.startsWith(' ') || l.startsWith('+')) lastCtxPlus = k;
    if (l.startsWith('+')) lastPlus = k;
  }
  const nx = raw[lastCtxPlus + 1];
  if (lastCtxPlus >= 0 && nx !== undefined && nx.startsWith('\\')) noEol = true;
  const nxp = raw[lastPlus + 1];
  if (lastPlus >= 0 && nxp !== undefined && nxp.startsWith('\\')) plusNoEol = true;
  while (raw.length > 0 && raw[raw.length - 1] === '') raw.pop();
  const o: string[] = [];
  const n: NLine[] = [];
  for (const l of raw) {
    if (l === '' || l.startsWith(' ')) { const t = l === '' ? '' : l.slice(1); o.push(t); n.push({ t, o: o.length - 1 }); }
    else if (l.startsWith('-')) o.push(l.slice(1));
    else if (l.startsWith('+')) n.push({ t: l.slice(1), o: -1 });
  }
  return { a, o, n, noEol, plusNoEol };
}

function parseUnified(lines: string[]): EditFn[] {
  const sections: RawSection[] = [];
  let cur: RawSection | null = null;
  let rawBody: string[] | null = null;
  let hunkA = 0;
  const hunkRe = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
  const startSection = (): RawSection => {
    const s: RawSection = { dash: undefined, plus: undefined, renameFrom: undefined, renameTo: undefined, diffX: undefined, diffY: undefined, create: false, del: false, hunks: [] };
    sections.push(s);
    return s;
  };
  const endBody = (): void => {
    if (rawBody !== null && cur !== null) { cur.hunks.push(finishHunk(rawBody, hunkA)); rawBody = null; }
  };
  const isBodyLine = (l: string): boolean => l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\');
  const diffPaths = (l: string): [string, string] | null => {
    if (!l.startsWith('diff --git a/')) return null;
    const rest = l.slice('diff --git a/'.length);
    const k = rest.indexOf(' b/');
    if (k < 0) return null;
    return [rest.slice(0, k), rest.slice(k + 3)];
  };
  const cleanPath = (raw: string): string | null => {
    let p = raw.split('\t')[0]!.trim();
    if (p === '/dev/null') return null;
    if (p.startsWith('a/')) p = p.slice(2);
    else if (p.startsWith('b/')) p = p.slice(2);
    return p;
  };
  let i = 0;
  while (i < lines.length) {
    const l = lines[i]!;
    if (rawBody !== null) {
      if (l.startsWith('diff --git ')) { endBody(); continue; }
      if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) { endBody(); continue; }
      if (isBodyLine(l)) { rawBody.push(l); i++; continue; }
      endBody();
      continue;
    }
    if (l.startsWith('diff --git ')) {
      const dp = diffPaths(l);
      if (dp === null) throw new ParseFail(`error: parse ${i + 1}`);
      cur = startSection();
      cur.diffX = dp[0]; cur.diffY = dp[1];
      i++;
      continue;
    }
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.dash !== undefined || cur.hunks.length > 0) cur = startSection();
      cur.dash = cleanPath(l.slice(4));
      cur.plus = cleanPath(lines[i + 1]!.slice(4));
      i += 2;
      continue;
    }
    if (cur === null) {
      if (l.startsWith('@@')) throw new ParseFail(`error: parse ${i + 1}`);
      i++;
      continue;
    }
    if (l.startsWith('--- ')) throw new ParseFail(`error: parse ${i + 2}`);
    if (l.startsWith('rename from ')) { cur.renameFrom = l.slice('rename from '.length).trim(); i++; continue; }
    if (l.startsWith('rename to ')) { cur.renameTo = l.slice('rename to '.length).trim(); i++; continue; }
    if (l.startsWith('new file mode')) { cur.create = true; i++; continue; }
    if (l.startsWith('deleted file mode')) { cur.del = true; i++; continue; }
    if (l.startsWith('@@')) {
      const m = hunkRe.exec(l);
      if (m === null) throw new ParseFail(`error: parse ${i + 1}`);
      rawBody = [];
      hunkA = parseInt(m[1]!, 10);
      i++;
      continue;
    }
    i++;
  }
  endBody();
  return sections.map((s) => sectionEdit(s));
}

function applyHunks(model: FileModel, hunks: Hunk[], strict: boolean, path: string): FileModel {
  const cur: FileModel = { lines: [...model.lines], br: model.br, final: model.final };
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0 && h.n.length === 0) continue;
    if (h.o.length === 0) {
      const at = Math.min(h.a + d, cur.lines.length);
      const ins = h.n.map((nl) => nl.t);
      const atEnd = at === cur.lines.length;
      cur.lines.splice(at, 0, ...ins);
      if (atEnd && ins.length > 0) cur.final = !h.noEol;
      d += h.n.length;
      continue;
    }
    const found = firstTier(h.o, cur.lines, strict, 0);
    if (!found) throw new EditFail('no-match', path);
    const target = h.a - 1 + d;
    let best = found.pos[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.pos) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) { best = p; bestDist = dist; }
    }
    const at = best;
    const repl = buildRepl(cur.lines, at, h.o, h.n, found.tier);
    const touchesEnd = at + h.o.length === cur.lines.length;
    cur.lines.splice(at, h.o.length, ...repl);
    if (touchesEnd) cur.final = !h.noEol;
    d += h.n.length - h.o.length;
  }
  return cur;
}

function sectionEdit(s: RawSection): EditFn {
  let oldP: string | null;
  let newP: string | null;
  if (s.dash !== undefined || s.plus !== undefined) {
    oldP = s.dash === undefined ? null : s.dash;
    newP = s.plus === undefined ? null : s.plus;
  } else {
    oldP = s.renameFrom !== undefined ? s.renameFrom : (s.diffX !== undefined ? s.diffX : null);
    newP = s.renameTo !== undefined ? s.renameTo : (s.diffY !== undefined ? s.diffY : null);
  }
  if (oldP === null || s.create) {
    const p = newP;
    return (tree) => {
      if (p === null) return;
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) !== null) throw new EditFail('exists', p);
      const plus: string[] = [];
      for (const h of s.hunks) for (const nl of h.n) if (nl.o < 0) plus.push(nl.t);
      let final = true;
      for (let k = s.hunks.length - 1; k >= 0; k--) {
        const h = s.hunks[k]!;
        if (h.n.some((nl) => nl.o < 0)) { final = !h.plusNoEol; break; }
      }
      tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (final ? '\n' : ''));
    };
  }
  if (newP === null || s.del) {
    const p = oldP;
    return (tree) => {
      if (!isSafe(p)) throw new EditFail('unsafe', p);
      if (tree.get(p) === null) throw new EditFail('missing', p);
      tree.now.set(p, null);
    };
  }
  if (oldP !== newP) {
    return (tree, strict) => {
      if (!isSafe(oldP)) throw new EditFail('unsafe', oldP);
      if (!isSafe(newP)) throw new EditFail('unsafe', newP);
      const cur = tree.get(oldP);
      if (cur === null) throw new EditFail('missing', oldP);
      if (tree.get(newP) !== null) throw new EditFail('exists', newP);
      const out = applyHunks(parseFile(cur), s.hunks, strict, oldP);
      tree.now.set(oldP, null);
      tree.now.set(newP, renderFile(out));
      movePairs.push([oldP, newP]);
    };
  }
  const p = oldP;
  return (tree, strict) => {
    if (!isSafe(p)) throw new EditFail('unsafe', p);
    const cur = tree.get(p);
    if (cur === null) throw new EditFail('missing', p);
    const out = applyHunks(parseFile(cur), s.hunks, strict, p);
    tree.now.set(p, renderFile(out));
  };
}

// ---- section 8: V4A patches ----
interface VChunk { anchor: string | null; o: string[]; n: NLine[]; eof: boolean; }
function vAddBody(ch: VChunk, l: string): void {
  if (l === '' || l.startsWith(' ')) { const t = l === '' ? '' : l.slice(1); ch.o.push(t); ch.n.push({ t, o: ch.o.length - 1 }); }
  else if (l.startsWith('-')) ch.o.push(l.slice(1));
  else if (l.startsWith('+')) ch.n.push({ t: l.slice(1), o: -1 });
}
function v4aEdits(lines: string[]): EditFn[] {
  const first = lines.findIndex((l) => !isBlank(l));
  if (first < 0) throw new ParseFail('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new ParseFail(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && isBlank(lines[last]!)) last--;
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new ParseFail(`error: parse ${lines.length + 1}`);
  const edits: EditFn[] = [];
  let i = first + 1;
  const isHeader = (l: string): boolean => l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  while (i < last) {
    const line = lines[i]!;
    if (isBlank(line)) { i++; continue; }
    if (line.startsWith('*** Add File: ')) {
      const path = line.slice('*** Add File: '.length).trim();
      i++;
      const body: string[] = [];
      while (i < last) {
        const l = lines[i]!;
        if (isHeader(l) || (l[0] === '*' && l.trim() === '*** End Patch')) break;
        if (l === '') { body.push(''); i++; continue; }
        if (l.startsWith('+')) { body.push(l.slice(1)); i++; continue; }
        throw new ParseFail(`error: parse ${i + 1}`);
      }
      while (body.length > 0 && body[body.length - 1] === '') body.pop();
      edits.push((tree) => {
        if (!isSafe(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) !== null) throw new EditFail('exists', path);
        tree.now.set(path, body.length === 0 ? '' : body.join('\n') + '\n');
      });
      continue;
    }
    if (line.startsWith('*** Delete File: ')) {
      const path = line.slice('*** Delete File: '.length).trim();
      i++;
      edits.push((tree) => {
        if (!isSafe(path)) throw new EditFail('unsafe', path);
        if (tree.get(path) === null) throw new EditFail('missing', path);
        tree.now.set(path, null);
      });
      continue;
    }
    if (line.startsWith('*** Update File: ')) {
      const updateLine = i + 1;
      const path = line.slice('*** Update File: '.length).trim();
      i++;
      while (i < last && isBlank(lines[i]!)) i++;
      let moveTo: string | null = null;
      if (i < last && lines[i]!.startsWith('*** Move to: ')) {
        moveTo = lines[i]!.slice('*** Move to: '.length).trim();
        i++;
      }
      const chunks: VChunk[] = [];
      let curChunk: VChunk | null = null;
      let firstChunk = true;
      while (i < last) {
        const l = lines[i]!;
        if (isHeader(l) || (l[0] === '*' && l.trim() === '*** End Patch')) break;
        if (l.startsWith('@@')) {
          if (curChunk) chunks.push(curChunk);
          curChunk = { anchor: l.slice(2).trim(), o: [], n: [], eof: false };
          firstChunk = false;
          i++;
          continue;
        }
        if (l[0] === '*' && l.trim() === '*** End of File') {
          if (!curChunk) throw new ParseFail(`error: parse ${i + 1}`);
          curChunk.eof = true;
          chunks.push(curChunk);
          curChunk = null;
          firstChunk = false;
          i++;
          continue;
        }
        if (l === '' && curChunk === null) { i++; continue; }
        if (l === '' || l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) {
          if (!curChunk) {
            if (!firstChunk) throw new ParseFail(`error: parse ${i + 1}`);
            curChunk = { anchor: null, o: [], n: [], eof: false };
          }
          vAddBody(curChunk, l);
          i++;
          continue;
        }
        throw new ParseFail(`error: parse ${i + 1}`);
      }
      if (curChunk) chunks.push(curChunk);
      if (chunks.length > 0) {
        const lc = chunks[chunks.length - 1]!;
        while (lc.o.length > 0 && lc.o[lc.o.length - 1] === '' && lc.n.length > 0 && lc.n[lc.n.length - 1]!.o === lc.o.length - 1) {
          lc.o.pop();
          lc.n.pop();
        }
      }
      if (chunks.length === 0 && moveTo === null) throw new ParseFail(`error: parse ${updateLine}`);
      edits.push(vUpdateEdit(path, moveTo, chunks));
      continue;
    }
    throw new ParseFail(`error: parse ${i + 1}`);
  }
  return edits;
}

function vUpdateEdit(path: string, moveTo: string | null, chunks: VChunk[]): EditFn {
  return (tree, strict) => {
    if (!isSafe(path)) throw new EditFail('unsafe', path);
    if (moveTo !== null && !isSafe(moveTo)) throw new EditFail('unsafe', moveTo);
    const cur = tree.get(path);
    if (cur === null) throw new EditFail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new EditFail('exists', moveTo);
    const model = parseFile(cur);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null && ch.anchor !== '') {
        const aFound = firstTier([ch.anchor], model.lines, strict, cursor);
        if (!aFound) throw new EditFail('no-match', path);
        cursor = aFound.pos[0]! + 1;
      }
      if (ch.o.length === 0) {
        const at = ch.eof ? model.lines.length : cursor;
        const ins = ch.n.map((nl) => nl.t);
        model.lines.splice(at, 0, ...ins);
        cursor = at + ins.length;
        continue;
      }
      const tiers = strict ? [0] : [0, 1, 2];
      let hit: { tier: number; at: number } | null = null;
      for (const t of tiers) {
        const pos = occAt(ch.o, model.lines, t, cursor).filter((p) => !ch.eof || p + ch.o.length === model.lines.length);
        if (pos.length > 0) { hit = { tier: t, at: pos[0]! }; break; }
      }
      if (!hit) throw new EditFail('no-match', path);
      const repl = buildRepl(model.lines, hit.at, ch.o, ch.n, hit.tier);
      model.lines.splice(hit.at, ch.o.length, ...repl);
      cursor = hit.at + repl.length;
    }
    const text = renderFile(model);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, text);
      movePairs.push([path, moveTo]);
    } else {
      tree.now.set(path, text);
    }
  };
}

// ---- section 10 + section 2: run, report, write ----
function run(args: string[]): { code: number; out: string[] } {
  movePairs = [];
  const cli = parseArgs(args);
  if (cli === null) return { code: 2, out: ['error: usage'] };
  let text = '';
  try {
    text = readFileSync(cli.patch ?? 0, 'utf8');
  } catch {
    if (cli.patch !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = splitPatch(text);
  const kind = cli.format === 'auto' ? detectFormat(lines) : cli.format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: EditFn[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines);
    else if (kind === 'search-replace') edits = srEdits(lines);
    else edits = v4aEdits(lines);
    if (edits.length === 0) throw new ParseFail('error: parse 1');
  } catch (e) {
    if (e instanceof ParseFail) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: EditFail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const movesBefore = movePairs.length;
    try {
      edit(tree, cli.strict);
    } catch (e) {
      if (!(e instanceof EditFail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      movePairs.length = movesBefore;
      fails.push(e);
    }
  }
  if (fails.length > 0) {
    return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  }
  const rows: Array<{ key: string; line: string }> = [];
  const covered = new Set<string>();
  for (const [oldP, newP] of movePairs) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
      covered.add(oldP);
      covered.add(newP);
    }
  }
  for (const p of [...tree.now.keys()].sort(cmpBuf)) {
    if (covered.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  if (!cli.check) {
    for (const p of [...tree.now.keys()]) {
      const was = tree.original(p);
      const now = tree.now.get(p)!;
      if (was === now) continue;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  rows.sort((a, b) => cmpBuf(a.key, b.key));
  const outLines = rows.map((r) => r.line);
  return { code: 0, out: [...outLines, `ok: ${outLines.length} ${outLines.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}







