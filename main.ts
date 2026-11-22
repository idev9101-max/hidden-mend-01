// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
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

function fileBreak(text: string): string {
  const nl = text.indexOf('\n');
  return nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
}

function fileLines(text: string): { lines: string[]; final: boolean; br: string } {
  const br = fileBreak(text);
  if (text === '') return { lines: [], final: false, br };
  const final = text.endsWith(br);
  const lines = text.split(br);
  if (final) lines.pop();
  return { lines, final, br };
}

function joinLines(lines: string[], br: string, final: boolean): string {
  if (lines.length === 0) return '';
  return lines.join(br) + (final ? br : '');
}

function trimTrail(s: string): string {
  return s.replace(/[ \t]+$/, '');
}
function trimBoth(s: string): string {
  return s.replace(/^[ \t]+|[ \t]+$/g, '');
}
function leadWs(s: string): string {
  const m = s.match(/^[ \t]*/);
  return m ? m[0] : '';
}

type Occurrence = { pos: number; tier: 0 | 1 | 2 };

function findOccurrences(file: string[], o: string[], strict: boolean): Occurrence[] | 'no-match' {
  const maxTier: 0 | 1 | 2 = strict ? 0 : 2;
  for (let tier = 0 as 0 | 1 | 2; tier <= maxTier; tier = (tier + 1) as 0 | 1 | 2) {
    const norm = tier === 0 ? (s: string) => s : tier === 1 ? trimTrail : trimBoth;
    const occ: Occurrence[] = [];
    if (o.length === 0) {
      for (let i = 0; i <= file.length; i++) occ.push({ pos: i, tier });
      return occ;
    }
    outer: for (let i = 0; i <= file.length - o.length; i++) {
      for (let j = 0; j < o.length; j++) {
        if (norm(file[i + j]!) !== norm(o[j]!)) continue outer;
      }
      occ.push({ pos: i, tier });
    }
    if (occ.length > 0) return occ;
  }
  return 'no-match';
}

function buildReplacement(file: string[], pos: number, o: string[], n: string[], tier: 0 | 1 | 2, ctxOld: Set<number>, ctxNew: Set<number>): string[] {
  const oldCtx: number[] = [];
  for (let i = 0; i < o.length; i++) if (ctxOld.has(i)) oldCtx.push(i);
  const out: string[] = [];
  let c = 0;
  for (let i = 0; i < n.length; i++) {
    if (ctxNew.has(i)) {
      const oi = oldCtx[c++] ?? oldCtx[oldCtx.length - 1] ?? 0;
      out.push(file[pos + oi]!);
      continue;
    }
    if (tier === 2 && o.length > 0) {
      const F = leadWs(file[pos]!);
      const P = leadWs(o[0]!);
      if (n[i] !== '' && !/^[ \t]*$/.test(n[i]!) && n[i]!.startsWith(P)) {
        out.push(F + n[i]!.slice(P.length));
        continue;
      }
    }
    out.push(n[i]!);
  }
  return [...file.slice(0, pos), ...out, ...file.slice(pos + o.length)];
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  readonly moves: { from: string; to: string }[] = [];
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

function ensureSafe(p: string, asWritten: string = p): void {
  if (!safe(asWritten)) throw new Fail('unsafe', asWritten);
}

function applyON(
  file: string[],
  o: string[],
  n: string[],
  strict: boolean,
  pick: (occ: Occurrence[]) => Occurrence | 'ambiguous',
  ctxOld: Set<number>,
  ctxNew: Set<number>,
): { lines: string[]; pos: number; tier: 0 | 1 | 2 } | Fail {
  const found = findOccurrences(file, o, strict);
  if (found === 'no-match') return new Fail('no-match', '');
  const chosen = pick(found);
  if (chosen === 'ambiguous') return new Fail('ambiguous', '');
  return { lines: buildReplacement(file, chosen.pos, o, n, chosen.tier, ctxOld, ctxNew), pos: chosen.pos, tier: chosen.tier };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  type Block = { path: string; searchLine: number; old: string[]; newLines: string[]; end: number };
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    if (trimTrail(lines[i]!) === '<<<<<<< SEARCH') {
      const searchLine = i + 1;
      let j = i + 1;
      let eq = -1;
      let end = -1;
      while (j < lines.length) {
        const t = trimTrail(lines[j]!);
        if (t === '=======') { eq = j; j++; break; }
        j++;
      }
      if (eq < 0) throw new Exit2(`error: parse ${searchLine}`);
      while (j < lines.length) {
        const t = trimTrail(lines[j]!);
        if (t === '>>>>>>> REPLACE') { end = j; break; }
        j++;
      }
      if (end < 0) throw new Exit2(`error: parse ${searchLine}`);
      let path: string | null = null;
      const prevEnd = blocks.length > 0 ? blocks[blocks.length - 1]!.end : -1;
      for (let k = i - 1; k > prevEnd; k--) {
        const l = lines[k]!;
        if (blank(l)) continue;
        const tr = l.trim();
        if (tr.startsWith('```')) continue;
        path = tr;
        break;
      }
      if (path === null && blocks.length > 0) path = blocks[blocks.length - 1]!.path;
      if (path === null) throw new Exit2(`error: parse ${searchLine}`);
      blocks.push({ path, searchLine, old: lines.slice(i + 1, eq), newLines: lines.slice(eq + 1, end), end });
      i = end + 1;
    } else i++;
  }
  if (blocks.length === 0) throw new Exit2('error: parse 1');
  return blocks.map((b) => (tree: Tree) => {
    const p = b.path;
    if (!safe(p)) throw new Fail('unsafe', p);
    if (b.old.length === 0) {
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, b.newLines.length === 0 ? '' : b.newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(p);
    if (before === null) throw new Fail('missing', p);
    const fl = fileLines(before);
    const found = findOccurrences(fl.lines, b.old, strict);
    if (found === 'no-match') throw new Fail('no-match', p);
    if (found.length !== 1) throw new Fail('ambiguous', p);
    const occ = found[0]!;
    const outLines = buildReplacement(fl.lines, occ.pos, b.old, b.newLines, occ.tier, new Set(), new Set());
    tree.now.set(p, joinLines(outLines, fl.br, fl.final));
  });
}

type UHunk = { a: number; b: number; c: number; d: number; headerLine: number; body: string[] };

function parseUnifiedHeaderPath(s: string): string {
  const t = s.slice(4);
  const tab = t.indexOf('\t');
  let p = (tab >= 0 ? t.slice(0, tab) : t).trim();
  if (p === '/dev/null') return p;
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseDiffGit(line: string, lineNo: number): { x: string; y: string } {
  const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
  if (!m) throw new Exit2(`error: parse ${lineNo}`);
  return { x: m[1]!, y: m[2]! };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) { last = i; break; }
  }
  if (last < 0 || lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);

  type Chunk = { anchor: string | null; eof: boolean; body: string[]; startLine: number };
  type Section = { kind: 'add' | 'delete' | 'update'; path: string; moveTo?: string; lines: string[]; lineNo: number; chunks: Chunk[] };
  const sections: Section[] = [];
  let i = first + 1;
  while (i < last) {
    const l = lines[i]!;
    if (blank(l)) { i++; continue; }
    if (l.startsWith('*** Add File: ')) {
      const p = l.slice('*** Add File: '.length).trim();
      const sec: Section = { kind: 'add', path: p, lines: [], lineNo: i + 1, chunks: [] };
      i++;
      while (i < last) {
        const ll = lines[i]!;
        if (ll.startsWith('*** Add File: ') || ll.startsWith('*** Delete File: ') || ll.startsWith('*** Update File: ') || ll.trim() === '*** End Patch') break;
        sec.lines.push(ll);
        i++;
      }
      // trim trailing blank lines at end of section
      while (sec.lines.length > 0 && blank(sec.lines[sec.lines.length - 1]!)) sec.lines.pop();
      sections.push(sec);
      continue;
    }
    if (l.startsWith('*** Delete File: ')) {
      const p = l.slice('*** Delete File: '.length).trim();
      sections.push({ kind: 'delete', path: p, lines: [], lineNo: i + 1, chunks: [] });
      i++;
      continue;
    }
    if (l.startsWith('*** Update File: ')) {
      const p = l.slice('*** Update File: '.length).trim();
      const sec: Section = { kind: 'update', path: p, lines: [], lineNo: i + 1, chunks: [] };
      i++;
      while (i < last) {
        const ll = lines[i]!;
        if (ll.startsWith('*** Add File: ') || ll.startsWith('*** Delete File: ') || ll.startsWith('*** Update File: ') || ll.trim() === '*** End Patch') break;
        sec.lines.push(ll);
        i++;
      }
      while (sec.lines.length > 0 && blank(sec.lines[sec.lines.length - 1]!)) sec.lines.pop();
      // parse update section
      let j = 0;
      if (j < sec.lines.length && sec.lines[j]!.startsWith('*** Move to: ')) {
        sec.moveTo = sec.lines[j]!.slice('*** Move to: '.length).trim();
        j++;
      }
      while (j < sec.lines.length) {
        const cl = sec.lines[j]!;
        if (blank(cl)) { j++; continue; }
        if (cl.startsWith('@@')) {
          const anchorText = cl.slice(2).trim();
          const chunk: Chunk = { anchor: anchorText === '' ? null : anchorText, eof: false, body: [], startLine: sec.lineNo + j + 1 };
          j++;
          while (j < sec.lines.length) {
            const bl = sec.lines[j]!;
            if (bl.startsWith('@@')) break;
            if (bl.startsWith('*** End of File')) { chunk.eof = true; j++; break; }
            if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ') || bl.startsWith('*** Move to: ')) break;
            if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl === '') { chunk.body.push(bl); j++; continue; }
            break;
          }
          sec.chunks.push(chunk);
          continue;
        }
        if (cl.startsWith(' ') || cl.startsWith('-') || cl.startsWith('+') || cl === '') {
          const chunk: Chunk = { anchor: null, eof: false, body: [], startLine: sec.lineNo + j };
          while (j < sec.lines.length) {
            const bl = sec.lines[j]!;
            if (bl.startsWith('@@')) break;
            if (bl.startsWith('*** End of File')) { chunk.eof = true; j++; break; }
            if (bl.startsWith('*** Add File: ') || bl.startsWith('*** Delete File: ') || bl.startsWith('*** Update File: ') || bl.startsWith('*** Move to: ')) break;
            if (bl.startsWith(' ') || bl.startsWith('-') || bl.startsWith('+') || bl === '') { chunk.body.push(bl); j++; continue; }
            break;
          }
          sec.chunks.push(chunk);
          continue;
        }
        throw new Exit2(`error: parse ${sec.lineNo + j}`);
      }
      if (sec.chunks.length === 0 && !sec.moveTo) throw new Exit2(`error: parse ${sec.lineNo}`);
      sections.push(sec);
      continue;
    }
    throw new Exit2(`error: parse ${i + 1}`);
  }

  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => (tree: Tree) => {
    if (!safe(s.path)) throw new Fail('unsafe', s.path);
    if (s.kind === 'add') {
      if (tree.get(s.path) !== null) throw new Fail('exists', s.path);
      const out = s.lines.map((l) => {
        if (l === '') return '';
        if (l.startsWith('+')) return l.slice(1);
        return l; // shouldn't happen per spec, but be lenient? spec says starts with +
      });
      tree.now.set(s.path, out.length === 0 ? '' : out.join('\n') + '\n');
      return;
    }
    if (s.kind === 'delete') {
      if (tree.get(s.path) === null) throw new Fail('missing', s.path);
      tree.now.set(s.path, null);
      return;
    }
    const before = tree.get(s.path);
    if (before === null) throw new Fail('missing', s.path);
    if (s.moveTo) {
      if (!safe(s.moveTo)) throw new Fail('unsafe', s.moveTo);
      if (tree.get(s.moveTo) !== null) throw new Fail('exists', s.moveTo);
    }
    const fl = fileLines(before);
    let curLines = [...fl.lines];
    let cursor = 0;
    for (const ch of s.chunks) {
      if (ch.anchor !== null) {
        let foundAnchor = -1;
        for (let tier = 0 as 0 | 1 | 2; tier <= (strict ? 0 : 2); tier = (tier + 1) as 0 | 1 | 2) {
          const norm = tier === 0 ? (x: string) => x : tier === 1 ? trimTrail : trimBoth;
          for (let k = cursor; k < curLines.length; k++) {
            if (norm(curLines[k]!) === norm(ch.anchor)) { foundAnchor = k; break; }
          }
          if (foundAnchor >= 0) break;
        }
        if (foundAnchor < 0) throw new Fail('no-match', s.path);
        cursor = foundAnchor + 1;
      }
      const o: string[] = [];
      const n: string[] = [];
      const ctxOld = new Set<number>();
      const ctxNew = new Set<number>();
      for (const bl of ch.body) {
        if (bl === '') { ctxOld.add(o.length); ctxNew.add(n.length); o.push(''); n.push(''); }
        else if (bl.startsWith(' ')) { ctxOld.add(o.length); ctxNew.add(n.length); o.push(bl.slice(1)); n.push(bl.slice(1)); }
        else if (bl.startsWith('-')) { o.push(bl.slice(1)); }
        else if (bl.startsWith('+')) { n.push(bl.slice(1)); }
      }
      if (o.length === 0) {
        const pos = ch.eof ? curLines.length : cursor;
        curLines = [...curLines.slice(0, pos), ...n, ...curLines.slice(pos)];
        cursor = pos + n.length;
      } else {
        const found = findOccurrences(curLines, o, strict);
        if (found === 'no-match') throw new Fail('no-match', s.path);
        let candidates = found.filter((occ) => occ.pos >= cursor);
        if (ch.eof) candidates = candidates.filter((occ) => occ.pos + o.length === curLines.length);
        if (candidates.length === 0) throw new Fail('no-match', s.path);
        // first occurrence at or after cursor, at the first tier with one - findOccurrences already returns first tier with any; but we need first at/after cursor at that tier
        const tier = candidates[0]!.tier;
        const atTier = candidates.filter((c) => c.tier === tier);
        const occ = atTier[0]!;
        curLines = buildReplacement(curLines, occ.pos, o, n, occ.tier, ctxOld, ctxNew);
        cursor = occ.pos + n.length;
      }
    }
    const outText = joinLines(curLines, fl.br, fl.final);
    if (s.moveTo) {
      tree.now.set(s.path, null);
      tree.now.set(s.moveTo, outText);
      tree.moves.push({ from: s.path, to: s.moveTo });
    } else {
      tree.now.set(s.path, outText);
    }
  });
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  type Section = {
    start: number;
    oldPath?: string;
    newPath?: string;
    renameFrom?: string;
    renameTo?: string;
    create: boolean;
    del: boolean;
    gitX?: string;
    gitY?: string;
    hunks: UHunk[];
  };
  const sections: Section[] = [];
  let cur: Section | null = null;
  let inHunk = false;
  let hunk: UHunk | null = null;

  const flushHunk = () => {
    if (hunk && cur) {
      // trim trailing empty lines from body that are not part of it? Spec: "empty lines at the end of a body are not part of it"
      while (hunk.body.length > 0 && hunk.body[hunk.body.length - 1] === '') hunk.body.pop();
      cur.hunks.push(hunk);
    }
    hunk = null;
    inHunk = false;
  };

  const isSectionStart = (i: number): boolean => {
    const l = lines[i]!;
    if (l.startsWith('diff --git ')) return true;
    if (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) return true;
    return false;
  };

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    const lineNo = i + 1;
    if (inHunk && hunk) {
      if (l.startsWith('@@')) {
        // new hunk header or parse error
        if (/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.test(l)) {
          flushHunk();
          const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)!;
          hunk = { a: +m[1]!, b: m[2] === undefined ? 1 : +m[2], c: +m[3]!, d: m[4] === undefined ? 1 : +m[4], headerLine: lineNo, body: [] };
          inHunk = true;
          continue;
        }
        throw new Exit2(`error: parse ${lineNo}`);
      }
      if (l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ '))) {
        flushHunk();
        // fallthrough to section start
      } else if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+') || l.startsWith('\\') || l === '') {
        hunk.body.push(l);
        continue;
      } else {
        flushHunk();
        // fallthrough to outside-body handling
      }
    }

    if (!inHunk) {
      if (l.startsWith('@@')) {
        if (!cur) throw new Exit2(`error: parse ${lineNo}`);
        const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/);
        if (!m) throw new Exit2(`error: parse ${lineNo}`);
        hunk = { a: +m[1]!, b: m[2] === undefined ? 1 : +m[2], c: +m[3]!, d: m[4] === undefined ? 1 : +m[4], headerLine: lineNo, body: [] };
        inHunk = true;
        continue;
      }
      if (isSectionStart(i)) {
        flushHunk();
        if (l.startsWith('diff --git ')) {
          const { x, y } = parseDiffGit(l, lineNo);
          cur = { start: lineNo, create: false, del: false, gitX: x, gitY: y, hunks: [] };
          sections.push(cur);
        } else {
          if (cur && cur.gitX && !cur.oldPath && !cur.newPath && sections[sections.length - 1] === cur && cur.hunks.length === 0) {
            cur.oldPath = parseUnifiedHeaderPath(l);
            i++;
            cur.newPath = parseUnifiedHeaderPath(lines[i]!);
          } else {
            cur = { start: lineNo, create: false, del: false, hunks: [] };
            sections.push(cur);
            cur.oldPath = parseUnifiedHeaderPath(l);
            i++;
            cur.newPath = parseUnifiedHeaderPath(lines[i]!);
          }
        }
        continue;
      }
      if (cur) {
        if (l.startsWith('--- ')) {
          // inside section header; if not followed by +++ it's parse error
          if (!(lines[i + 1] ?? '').startsWith('+++ ')) throw new Exit2(`error: parse ${lineNo + 1}`);
          cur.oldPath = parseUnifiedHeaderPath(l);
          i++;
          cur.newPath = parseUnifiedHeaderPath(lines[i]!);
          continue;
        }
        if (l.startsWith('rename from ')) { cur.renameFrom = l.slice('rename from '.length).trim(); continue; }
        if (l.startsWith('rename to ')) { cur.renameTo = l.slice('rename to '.length).trim(); continue; }
        if (l.startsWith('new file mode')) { cur.create = true; continue; }
        if (l.startsWith('deleted file mode')) { cur.del = true; continue; }
        // ignored header/other lines
        continue;
      }
      // outside sections, ignored
    }
  }
  flushHunk();

  if (sections.length === 0) throw new Exit2('error: parse 1');

  return sections.map((s) => (tree: Tree) => {
    let oldPath = s.oldPath;
    let newPath = s.newPath;
    if (!oldPath && !newPath && s.renameFrom && s.renameTo) { oldPath = s.renameFrom; newPath = s.renameTo; }
    if (!oldPath && s.gitX) oldPath = s.gitX;
    if (!newPath && s.gitY) newPath = s.gitY;
    if (!oldPath && !newPath) throw new Fail('no-match', '');

    const isCreate = s.create || oldPath === '/dev/null';
    const isDelete = s.del || newPath === '/dev/null';
    if (isCreate) {
      const p = newPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      const out: string[] = [];
      let final = true;
      for (const h of s.hunks) {
        for (let bi = 0; bi < h.body.length; bi++) {
          const bl = h.body[bi]!;
          if (bl.startsWith('+')) out.push(bl.slice(1));
          else if (bl.startsWith('\\')) {
            if (bi > 0 && h.body[bi - 1]!.startsWith('+')) final = false;
          }
        }
      }
      // if a \ follows last + line overall
      const allBody = s.hunks.flatMap((h) => h.body);
      for (let bi = 0; bi < allBody.length; bi++) {
        if (allBody[bi]!.startsWith('\\') && bi > 0 && allBody[bi - 1]!.startsWith('+')) {
          // only matters if it's the last + in whole created file
          let lastPlus = -1;
          for (let k = 0; k < allBody.length; k++) if (allBody[k]!.startsWith('+')) lastPlus = k;
          if (bi === lastPlus + 1 && lastPlus >= 0) final = false;
        }
      }
      // created file ends with line break unless \ follows its last + line
      let lastPlusIdx = -1;
      for (let bi = 0; bi < allBody.length; bi++) if (allBody[bi]!.startsWith('+')) lastPlusIdx = bi;
      final = !(lastPlusIdx >= 0 && lastPlusIdx + 1 < allBody.length && allBody[lastPlusIdx + 1]!.startsWith('\\'));
      if (out.length === 0) final = false;
      tree.now.set(p, joinLines(out, '\n', final));
      return;
    }
    if (isDelete) {
      const p = oldPath!;
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) === null) throw new Fail('missing', p);
      tree.now.set(p, null);
      return;
    }

    const op = oldPath!;
    const np = newPath ?? op;
    if (!safe(op)) throw new Fail('unsafe', op);
    if (!safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (op !== np && tree.get(np) !== null) throw new Fail('exists', np);

    const fl = fileLines(before);
    let curLines = [...fl.lines];
    let curFinal = fl.final;
    let dOff = 0;
    for (const h of s.hunks) {
      const o: string[] = [];
      const n: string[] = [];
      const ctxOld = new Set<number>();
      const ctxNew = new Set<number>();
      for (const bl of h.body) {
        if (bl === '') { ctxOld.add(o.length); ctxNew.add(n.length); o.push(''); n.push(''); }
        else if (bl.startsWith(' ')) { ctxOld.add(o.length); ctxNew.add(n.length); o.push(bl.slice(1)); n.push(bl.slice(1)); }
        else if (bl.startsWith('-')) { o.push(bl.slice(1)); }
        else if (bl.startsWith('+')) { n.push(bl.slice(1)); }
        else if (bl.startsWith('\\')) { /* handled below */ }
      }
      let resLines: string[];
      let pos: number;
      let tier: 0 | 1 | 2 = 0;
      if (o.length === 0) {
        pos = Math.min(h.a + dOff, curLines.length);
        resLines = [...curLines.slice(0, pos), ...n, ...curLines.slice(pos)];
        tier = 0;
      } else {
        const found = findOccurrences(curLines, o, strict);
        if (found === 'no-match') throw new Fail('no-match', op);
        const target = h.a - 1 + dOff;
        let best = found[0]!;
        let bestDist = Math.abs(best.pos - target);
        for (const occ of found) {
          const dist = Math.abs(occ.pos - target);
          if (dist < bestDist || (dist === bestDist && occ.pos < best.pos)) { best = occ; bestDist = dist; }
        }
        pos = best.pos;
        tier = best.tier;
        resLines = buildReplacement(curLines, pos, o, n, tier, ctxOld, ctxNew);
      }

      // no-eol handling
      const body = h.body;
      let lastCtxOrPlus: 'none' | 'ctx' | 'plus' = 'none';
      let lastCtxOrPlusIdx = -1;
      for (let bi = 0; bi < body.length; bi++) {
        const bl = body[bi]!;
        if (bl.startsWith(' ') || bl === '') { lastCtxOrPlus = 'ctx'; lastCtxOrPlusIdx = bi; }
        else if (bl.startsWith('+')) { lastCtxOrPlus = 'plus'; lastCtxOrPlusIdx = bi; }
      }
      let hasNoEolAfterLast = false;
      if (lastCtxOrPlusIdx >= 0 && lastCtxOrPlusIdx + 1 < body.length && body[lastCtxOrPlusIdx + 1]!.startsWith('\\')) hasNoEolAfterLast = true;
      // also check if \ follows last context or + line anywhere as specified: "when a hunk's matched lines run to end..." 
      // "the result ends with a line break unless a \ line follows the hunk's last context or + line"
      const matchedToEnd = (o.length === 0) ? (pos >= curLines.length) : (pos + o.length >= curLines.length);
      if (matchedToEnd) {
        curFinal = !hasNoEolAfterLast;
      } else {
        // "when they do not, the file's final break stays as it was"
        // curFinal unchanged
      }

      curLines = resLines;
      dOff += n.length - o.length;
    }

    const outText = joinLines(curLines, fl.br, curFinal);
    if (op !== np) {
      tree.now.set(op, null);
      tree.now.set(np, outText);
      tree.moves.push({ from: op, to: np });
    } else {
      tree.now.set(op, outText);
    }
  });
}

function run(args: string[]): { code: number; out: string[] } {
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
    else if (kind === 'search-replace') edits = searchReplaceEdits(lines, strict);
    else if (kind === 'unified') edits = unifiedEdits(lines, strict);
    else if (kind === 'v4a') edits = v4aEdits(lines, strict);
    else edits = [];
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
  const rows: { sort: string; line: string }[] = [];
  const movedFrom = new Set<string>();
  const movedTo = new Set<string>();
  for (const m of tree.moves) {
    const was = tree.original(m.from);
    const now = tree.now.get(m.to);
    if (was !== null && tree.now.has(m.from) && tree.now.get(m.from) === null && was !== now && now !== null && tree.original(m.to) === null) {
      movedFrom.add(m.from);
      movedTo.add(m.to);
    }
  }
  for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    if (movedFrom.has(p) && now === null) continue;
    if (movedTo.has(p) && was === null) {
      const from = tree.moves.find((m) => m.to === p && movedFrom.has(m.from))!.from;
      rows.push({ sort: p, line: `R ${from} -> ${p}` });
      continue;
    }
    rows.push({ sort: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
    if (check) continue;
    if (now === null) rmSync(p, { force: true });
    else {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, now);
    }
  }
  // write moved files too
  if (!check) {
    for (const m of tree.moves) {
      if (movedFrom.has(m.from) && movedTo.has(m.to)) {
        rmSync(m.from, { force: true });
        const now = tree.now.get(m.to);
        if (now !== null) {
          mkdirSync(dirname(m.to), { recursive: true });
          writeFileSync(m.to, now);
        }
      }
    }
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.sort), Buffer.from(b.sort)));
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
