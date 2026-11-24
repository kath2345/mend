// main.ts is mend, the CLI SPEC.md specifies. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// Implements SPEC.md sections 1 to 10: the command line, the output and exit codes, safe paths, format detection,
// line matching at three tiers (section 5), unified diffs (section 6), SEARCH/REPLACE blocks (section 7), V4A
// patches (section 8), JSON edits (section 9) and the all-or-nothing write (section 10).
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

/** Moves that succeeded, as (old, new) pairs, for the `R` output lines (SPEC.md section 2). */
const moves: Array<[string, string]> = [];

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

// ---------------------------------------------------------------------------
// Files and lines (SPEC.md section 3)
// ---------------------------------------------------------------------------

interface FileState {
  lines: string[];
  br: string;
  fin: boolean;
}

function splitFile(text: string): FileState {
  if (text === '') return { lines: [], br: '\n', fin: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { lines: parts, br, fin };
}

function joinFile(lines: string[], br: string, fin: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (fin ? br : '');
}

// ---------------------------------------------------------------------------
// Line matching (SPEC.md section 5)
// ---------------------------------------------------------------------------

const trimEndST = (s: string): string => s.replace(/[ \t]+$/, '');
const trimST = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadST = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function lineEq(a: string, b: string, tier: number): boolean {
  if (tier === 0) return a === b;
  if (tier === 1) return trimEndST(a) === trimEndST(b);
  return trimST(a) === trimST(b);
}

function tiers(strict: boolean): number[] {
  return strict ? [0] : [0, 1, 2];
}

/** Positions where O occurs in `file` at `tier`, at or after `from`. */
function occurrences(file: string[], O: string[], tier: number, from = 0): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= file.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!lineEq(file[i + j]!, O[j], tier)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier at which O occurs at or after `from`, with its positions. */
function findFirstTier(file: string[], O: string[], from: number, strict: boolean): { tier: number; occ: number[] } | null {
  for (const t of tiers(strict)) {
    const occ = occurrences(file, O, t, from);
    if (occ.length > 0) return { tier: t, occ };
  }
  return null;
}

/** The first line at or after `from` equal to `anchor`, at the first tier where one is. */
function findSingle(file: string[], anchor: string, from: number, strict: boolean): number | null {
  for (const t of tiers(strict)) {
    for (let i = from; i < file.length; i++) {
      if (lineEq(file[i]!, anchor, t)) return i;
    }
  }
  return null;
}

interface Op {
  kind: 'ctx' | 'del' | 'add';
  text: string;
  /** a `\` line follows this body line */
  bs?: boolean;
}

function opsON(ops: Op[]): { O: string[]; N: string[] } {
  const O: string[] = [];
  const N: string[] = [];
  for (const op of ops) {
    if (op.kind === 'ctx') {
      O.push(op.text);
      N.push(op.text);
    } else if (op.kind === 'del') O.push(op.text);
    else N.push(op.text);
  }
  return { O, N };
}

/** The lines that replace the matched lines: context lines are the file's own, `add` lines re-indented at tier 2. */
function buildReplacement(file: string[], pos: number, ops: Op[], tier: number): string[] {
  const { O } = opsON(ops);
  let F = '';
  let P = '';
  if (tier === 2 && O.length > 0) {
    F = leadST(file[pos] ?? '');
    P = leadST(O[0]);
  }
  const out: string[] = [];
  let oi = 0;
  for (const op of ops) {
    if (op.kind === 'ctx') {
      out.push(file[pos + oi]!);
      oi++;
    } else if (op.kind === 'del') {
      oi++;
    } else {
      let t = op.text;
      if (tier === 2 && t !== '' && /[^ \t]/.test(t) && t.startsWith(P)) t = F + t.slice(P.length);
      out.push(t);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// JSON edits (SPEC.md section 9)
// ---------------------------------------------------------------------------

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------------------------------------------------------------------------
// Unified diffs (SPEC.md section 6)
// ---------------------------------------------------------------------------

/** The path after `--- ` or `+++ `, up to the first tab, trimmed; `/dev/null` is null. */
function parsePatchPath(line: string): string | null {
  let t = line.slice(4);
  const tab = t.indexOf('\t');
  if (tab >= 0) t = t.slice(0, tab);
  t = t.trim();
  if (t === '/dev/null') return null;
  if (t.startsWith('a/') || t.startsWith('b/')) t = t.slice(2);
  return t;
}

interface Hunk {
  A: number;
  ops: Op[];
  noFinal: boolean;
}

interface USection {
  diffOld: string | null;
  diffNew: string | null;
  renFrom: string | null;
  renTo: string | null;
  pairOld: string | null;
  pairNew: string | null;
  hasPair: boolean;
  lonePlus: string | null;
  createFlag: boolean;
  delFlag: boolean;
  hunks: Hunk[];
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: USection[] = [];
  let cur: USection | null = null;
  let headerDone = false;
  let hunk: Hunk | null = null;

  const newSection = (): USection => {
    const s: USection = {
      diffOld: null,
      diffNew: null,
      renFrom: null,
      renTo: null,
      pairOld: null,
      pairNew: null,
      hasPair: false,
      lonePlus: null,
      createFlag: false,
      delFlag: false,
      hunks: [],
    };
    sections.push(s);
    cur = s;
    headerDone = false;
    hunk = null;
    return s;
  };

  const endHunk = (): void => {
    if (hunk === null) return;
    while (hunk.ops.length > 0) {
      const last = hunk.ops[hunk.ops.length - 1]!;
      if (last.kind === 'ctx' && last.text === '') hunk.ops.pop();
      else break;
    }
    hunk.noFinal = false;
    for (let k = hunk.ops.length - 1; k >= 0; k--) {
      const op = hunk.ops[k]!;
      if (op.kind === 'ctx' || op.kind === 'add') {
        hunk.noFinal = op.bs === true;
        break;
      }
    }
    cur!.hunks.push(hunk);
    hunk = null;
  };

  const hunkHead = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
  const diffGit = /^diff --git a\/(.+?) b\/(.+)$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    if (hunk !== null) {
      if (line.startsWith('diff --git ')) {
        endHunk();
        continue;
      }
      if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
        endHunk();
        continue;
      }
      if (line.startsWith(' ') || line.startsWith('-') || line.startsWith('+') || line.startsWith('\\') || line === '') {
        if (line.startsWith('\\')) {
          const last = hunk.ops[hunk.ops.length - 1];
          if (last) last.bs = true;
        } else if (line === '') hunk.ops.push({ kind: 'ctx', text: '' });
        else if (line.startsWith(' ')) hunk.ops.push({ kind: 'ctx', text: line.slice(1) });
        else if (line.startsWith('-')) hunk.ops.push({ kind: 'del', text: line.slice(1) });
        else hunk.ops.push({ kind: 'add', text: line.slice(1) });
        i++;
        continue;
      }
      endHunk();
      continue;
    }
    if (line.startsWith('diff --git ')) {
      const m = diffGit.exec(line.trimEnd());
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const s = newSection();
      s.diffOld = m[1];
      s.diffNew = m[2];
      i++;
      continue;
    }
    if (line.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) {
      if (cur === null || cur.hasPair || headerDone) {
        const s = newSection();
        s.pairOld = parsePatchPath(line);
        s.pairNew = parsePatchPath(lines[i + 1]!);
        s.hasPair = true;
      } else {
        cur.pairOld = parsePatchPath(line);
        cur.pairNew = parsePatchPath(lines[i + 1]!);
        cur.hasPair = true;
      }
      i += 2;
      continue;
    }
    if (line.startsWith('--- ')) {
      if (cur !== null && !headerDone) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('+++ ')) {
      if (cur !== null && !headerDone && cur.lonePlus === null) cur.lonePlus = parsePatchPath(line);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      const m = hunkHead.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      hunk = { A: parseInt(m[1], 10), ops: [], noFinal: false };
      headerDone = true;
      i++;
      continue;
    }
    if (cur !== null && !headerDone) {
      if (line.startsWith('rename from ')) cur.renFrom = line.slice(12).trim();
      else if (line.startsWith('rename to ')) cur.renTo = line.slice(10).trim();
      else if (line.startsWith('new file mode')) cur.createFlag = true;
      else if (line.startsWith('deleted file mode')) cur.delFlag = true;
      i++;
      continue;
    }
    i++;
  }
  if (hunk !== null) endHunk();
  return sections.map((s) => makeUnifiedEdit(s, strict));
}

function applyUnifiedHunk(cur: FileState, h: Hunk, d: number, strict: boolean, path: string): FileState {
  const { O, N } = opsON(h.ops);
  const lines = cur.lines;
  if (O.length === 0) {
    const pos = Math.min(Math.max(h.A + d, 0), lines.length);
    const out = [...lines.slice(0, pos), ...N, ...lines.slice(pos)];
    const fin = pos === lines.length ? !h.noFinal : cur.fin;
    return { lines: out, br: cur.br, fin };
  }
  const found = findFirstTier(lines, O, 0, strict);
  if (!found) throw new Fail('no-match', path);
  const target = h.A - 1 + d;
  let best = found.occ[0]!;
  let bestDist = Math.abs(best - target);
  for (const p of found.occ) {
    const dist = Math.abs(p - target);
    if (dist < bestDist) {
      best = p;
      bestDist = dist;
    }
  }
  const replacement = buildReplacement(lines, best, h.ops, found.tier);
  const out = [...lines.slice(0, best), ...replacement, ...lines.slice(best + O.length)];
  const fin = best + O.length === lines.length ? !h.noFinal : cur.fin;
  return { lines: out, br: cur.br, fin };
}

function makeUnifiedEdit(s: USection, strict: boolean): Edit {
  const oldP = s.hasPair ? s.pairOld : (s.renFrom ?? s.diffOld);
  const newP = s.hasPair ? s.pairNew : (s.renTo ?? s.lonePlus ?? s.diffNew);
  const isCreate = s.createFlag || oldP === null;
  const isDelete = !isCreate && (s.delFlag || newP === null);
  const isMove = !isCreate && !isDelete && oldP !== null && newP !== null && oldP !== newP;
  return (tree) => {
    if (oldP !== null && !safe(oldP)) throw new Fail('unsafe', oldP);
    if (newP !== null && !safe(newP)) throw new Fail('unsafe', newP);
    if (isCreate) {
      const p = newP!;
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const plus: string[] = [];
      let lastAddBs = false;
      let hasAdd = false;
      for (const h of s.hunks) {
        for (const op of h.ops) {
          if (op.kind === 'add') {
            plus.push(op.text);
            lastAddBs = op.bs === true;
            hasAdd = true;
          }
        }
      }
      tree.now.set(p, hasAdd ? plus.join('\n') + (lastAddBs ? '' : '\n') : '');
      return;
    }
    if (isDelete) {
      const p = oldP!;
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }
    if (isMove) {
      const op = oldP!;
      const np = newP!;
      const before = tree.get(op);
      if (before === null) throw new Fail('missing', op);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      let cur = splitFile(before);
      let d = 0;
      for (const h of s.hunks) {
        cur = applyUnifiedHunk(cur, h, d, strict, op);
        const { O, N } = opsON(h.ops);
        d += N.length - O.length;
      }
      tree.now.set(op, null);
      tree.now.set(np, joinFile(cur.lines, cur.br, cur.fin));
      moves.push([op, np]);
      return;
    }
    const p = oldP!;
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    let cur = splitFile(before);
    let d = 0;
    for (const h of s.hunks) {
      cur = applyUnifiedHunk(cur, h, d, strict, p);
      const { O, N } = opsON(h.ops);
      d += N.length - O.length;
    }
    tree.now.set(p, joinFile(cur.lines, cur.br, cur.fin));
  };
}

// ---------------------------------------------------------------------------
// SEARCH/REPLACE blocks (SPEC.md section 7)
// ---------------------------------------------------------------------------

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  while (i < lines.length) {
    let si = -1;
    for (let j = i; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        si = j;
        break;
      }
    }
    if (si < 0) break;
    let path: string | null = null;
    for (let j = si - 1; j > prevEnd; j--) {
      const t = lines[j]!.trim();
      if (t === '') continue;
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${si + 1}`);
      path = prevPath;
    }
    let eq = -1;
    let rep = -1;
    for (let j = si + 1; j < lines.length; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${si + 1}`);
    for (let j = eq + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${si + 1}`);
    const oldLines = lines.slice(si + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(makeSREdit(path, oldLines, newLines, strict));
    prevPath = path;
    prevEnd = rep;
    i = rep + 1;
  }
  return edits;
}

function makeSREdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const { lines, br, fin } = splitFile(before);
    const found = findFirstTier(lines, oldLines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.occ.length > 1) throw new Fail('ambiguous', path);
    const pos = found.occ[0]!;
    const ops: Op[] = [
      ...oldLines.map((t): Op => ({ kind: 'del', text: t })),
      ...newLines.map((t): Op => ({ kind: 'add', text: t })),
    ];
    const replacement = buildReplacement(lines, pos, ops, found.tier);
    const out = [...lines.slice(0, pos), ...replacement, ...lines.slice(pos + oldLines.length)];
    tree.now.set(path, joinFile(out, br, fin));
  };
}

// ---------------------------------------------------------------------------
// V4A patches (SPEC.md section 8)
// ---------------------------------------------------------------------------

interface VChunk {
  anchor: string | null;
  ops: Op[];
  eof: boolean;
}

interface RawLine {
  text: string;
  no: number;
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    if (!blank(lines[k]!)) {
      last = k;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i++;
      continue;
    }
    const line = lines[i]!;
    let kind: 'add' | 'delete' | 'update' | null = null;
    let path = '';
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice(14).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice(17).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice(17).trim();
    } else {
      throw new Exit2(`error: parse ${i + 1}`);
    }
    let j = i + 1;
    const raw: RawLine[] = [];
    while (j < last) {
      const l = lines[j]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, no: j + 1 });
      j++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(makeV4aEdit(kind, path, raw, i + 1, strict));
    i = j;
  }
  return edits;
}

function makeV4aEdit(kind: 'add' | 'delete' | 'update', path: string, raw: RawLine[], headerNo: number, strict: boolean): Edit {
  if (kind === 'add') {
    const outLines: string[] = [];
    for (const { text, no } of raw) {
      if (text === '') outLines.push('');
      else if (text.startsWith('+')) outLines.push(text.slice(1));
      else throw new Exit2(`error: parse ${no}`);
    }
    const content = outLines.length === 0 ? '' : outLines.join('\n') + '\n';
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content);
    };
  }
  if (kind === 'delete') {
    for (const { no } of raw) throw new Exit2(`error: parse ${no}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // update
  let moveTo: string | null = null;
  let idx = 0;
  if (raw.length > 0 && raw[0]!.text.startsWith('*** Move to: ')) {
    moveTo = raw[0]!.text.slice(12).trim();
    idx = 1;
  }
  const chunks: VChunk[] = [];
  let cur: VChunk | null = null;
  let started = false;
  for (; idx < raw.length; idx++) {
    const { text, no } = raw[idx]!;
    if (text.startsWith('@@')) {
      if (cur) chunks.push(cur);
      cur = { anchor: text.slice(2).trim(), ops: [], eof: false };
      started = true;
    } else if (text.trim() === '*** End of File') {
      if (!cur) throw new Exit2(`error: parse ${no}`);
      cur.eof = true;
      chunks.push(cur);
      cur = null;
    } else if (text.startsWith(' ') || text.startsWith('-') || text.startsWith('+') || text === '') {
      if (!cur) {
        if (started) throw new Exit2(`error: parse ${no}`);
        cur = { anchor: null, ops: [], eof: false };
        started = true;
      }
      if (text === '') cur.ops.push({ kind: 'ctx', text: '' });
      else if (text.startsWith(' ')) cur.ops.push({ kind: 'ctx', text: text.slice(1) });
      else if (text.startsWith('-')) cur.ops.push({ kind: 'del', text: text.slice(1) });
      else cur.ops.push({ kind: 'add', text: text.slice(1) });
    } else {
      throw new Exit2(`error: parse ${no}`);
    }
  }
  if (cur) chunks.push(cur);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNo}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const st = splitFile(before);
    let fileLines = st.lines;
    let cursor = 0;
    for (const chunk of chunks) {
      if (chunk.anchor !== null && chunk.anchor !== '') {
        const at = findSingle(fileLines, chunk.anchor, cursor, strict);
        if (at === null) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O } = opsON(chunk.ops);
      if (O.length === 0) {
        const N = chunk.ops.filter((o) => o.kind === 'add').map((o) => o.text);
        const pos = chunk.eof ? fileLines.length : cursor;
        fileLines = [...fileLines.slice(0, pos), ...N, ...fileLines.slice(pos)];
        cursor = pos + N.length;
        continue;
      }
      let pos: number;
      let tier: number;
      if (chunk.eof) {
        let found: { tier: number; pos: number } | null = null;
        for (const t of tiers(strict)) {
          const occ = occurrences(fileLines, O, t, cursor).filter((p) => p + O.length === fileLines.length);
          if (occ.length > 0) {
            found = { tier: t, pos: occ[0]! };
            break;
          }
        }
        if (!found) throw new Fail('no-match', path);
        pos = found.pos;
        tier = found.tier;
      } else {
        const found = findFirstTier(fileLines, O, cursor, strict);
        if (!found) throw new Fail('no-match', path);
        pos = found.occ[0]!;
        tier = found.tier;
      }
      const replacement = buildReplacement(fileLines, pos, chunk.ops, tier);
      fileLines = [...fileLines.slice(0, pos), ...replacement, ...fileLines.slice(pos + O.length)];
      cursor = pos + replacement.length;
    }
    const out = joinFile(fileLines, st.br, st.fin);
    if (moveTo !== null) {
      tree.now.set(path, null);
      tree.now.set(moveTo, out);
      moves.push([path, moveTo]);
    } else {
      tree.now.set(path, out);
    }
  };
}

// ---------------------------------------------------------------------------
// Invocation, output and exit codes (SPEC.md sections 1, 2 and 10)
// ---------------------------------------------------------------------------

function run(args: string[]): { code: number; out: string[] } {
  // Per-run state: a run must not see moves from an earlier run in this process.
  moves.length = 0;
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    if (kind === 'json') edits = jsonEdits(text, lines);
    else if (kind === 'unified') edits = parseUnified(lines, strict);
    else if (kind === 'search-replace') edits = parseSearchReplace(lines, strict);
    else edits = parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  // Write the tree (unless --check), then report what changed.
  if (!check) {
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
  const movedNew = new Map<string, string>();
  const movedOld = new Set<string>();
  for (const [oldP, newP] of moves) {
    if (tree.original(oldP) !== null && tree.get(oldP) === null && tree.original(newP) === null && tree.get(newP) !== null) {
      movedNew.set(newP, oldP);
      movedOld.add(oldP);
    }
  }
  const rows: { key: string; line: string }[] = [];
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (now === null && movedOld.has(p)) continue;
    if (was === null && movedNew.has(p)) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  for (const [newP, oldP] of movedNew) rows.push({ key: newP, line: `R ${oldP} -> ${newP}` });
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const out = rows.map((r) => r.line);
  return { code: 0, out: [...out, `ok: ${out.length} ${out.length === 1 ? 'file' : 'files'}`] };
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
