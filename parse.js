// parse.js — a dependency-free, hand-written CommonMark 0.31.2 + GFM parser
// that renders exactly the HTML marked 18.1.3 renders with its default
// options (gfm on, breaks off). Written from the spec and from probing the
// reference outputs; no code is copied from any other renderer.
// parse(markdown) is stateless across calls: nothing is kept from one call
// to the next, so every case is rendered alone.


// ---- small helpers ----
const PUNCT = new Set('!"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~'.split(''));
function isPunct(ch) { if (ch === undefined) return false; const c = ch.charCodeAt(0); if (c < 128) return PUNCT.has(ch); return /\p{P}|\p{S}/u.test(ch); }
function isSpace(ch) { return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f' || ch === '\v' || ch === '\u00A0' || ch === ' ' || (ch !== undefined && ch.charCodeAt(0) >= 0x2000 && ch.charCodeAt(0) <= 0x200a); }
function isBlankStr(s) { for (let i = 0; i < s.length; i++) { const c = s[i]; if (c !== ' ' && c !== '\t' && c !== '\r' && c !== '\n') return false; } return true; }

// Unescape backslash escapes of ASCII punctuation.
function unesc(s) {
  if (!s.includes('\\')) return s;
  let out = '';
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\' && i + 1 < s.length && PUNCT.has(s[i + 1])) { out += s[i + 1]; i++; }
    else out += s[i];
  }
  return out;
}

// Column width of a line prefix: space = 1, tab = to next multiple of 4.
function colOf(line, upto) {
  let col = 0;
  for (let i = 0; i < upto && i < line.length; i++) {
    if (line[i] === '\t') col += 4 - (col % 4); else col += 1;
  }
  return col;
}
// Number of columns the leading whitespace of a line spans.
function indentCols(line) {
  let col = 0, i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') col += 4 - (col % 4); else col += 1;
    i++;
  }
  return col;
}
// Strip n columns from the start of a line. Columns are the line's own:
// a tab spans to the next multiple of 4, and a tab that straddles the cut
// leaves spaces for its remainder; later leading tabs are then expanded to
// spaces of their original widths, so column positions after the cut stay
// exactly as they were in the original line.
function stripCols(line, n, baseCol, force, expandAtCut) {
  let cut = 0, col = baseCol === undefined ? 0 : baseCol, i = 0, prefix = '', straddled = false;
  while (i < line.length && cut < n) {
    const ch = line[i];
    if (ch === '\t') {
      const w = 4 - (col % 4);
      if (cut + w > n) { prefix += ' '.repeat(cut + w - n); straddled = true; cut = n; col += w; i++; break; }
      cut += w; col += w; i++;
    } else if (ch === ' ') { cut += 1; col += 1; i++; }
    else if (force) { cut += 1; col += 1; i++; }
    else break;
  }
  if (!straddled && expandAtCut) straddled = true;
  if (!straddled) return line.slice(i);
  let out = prefix;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) {
    if (line[i] === '\t') { const w = 4 - (col % 4); out += ' '.repeat(w); col += w; i++; }
    else { out += ' '; col += 1; i++; }
  }
  return out + line.slice(i);
}

// Escape &, <, > for text/code content. `&` is handled by the caller when
// entity decoding applies; this one escapes every &.
function escAmpLtGt(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') { out += s.slice(start, i) + '&amp;'; start = i + 1; }
    else if (c === '<') { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === '>') { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === '"') { out += s.slice(start, i) + '&quot;'; start = i + 1; }
    else if (c === "'") { out += s.slice(start, i) + '&#39;'; start = i + 1; }
  }
  return out + s.slice(start);
}

// Decode one entity starting at s[i] === '&'. Returns [decoded, length] or null.
function tryEntity(s, i) {
  // numeric: &#123; &#x1F600; &#X22;
  if (s[i + 1] === '#') {
    let j = i + 2, hex = false;
    if (s[j] === 'x' || s[j] === 'X') { hex = true; j++; }
    const start = j;
    while (j < s.length && (hex ? /[0-9a-fA-F]/.test(s[j]) : /[0-9]/.test(s[j]))) j++;
    if (j === start || j >= s.length || s[j] !== ';') return null;
    const num = s.slice(start, j);
    if (!hex && num.length > 7) return null;
    let cp = parseInt(num, hex ? 16 : 10);
    if (!isFinite(cp) || cp === 0 || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) cp = 0xFFFD;
    return [String.fromCodePoint(cp), j - i + 1];
  }
  // named: &name;
  let j = i + 1;
  while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
  if (j < s.length && s[j] === ';' && j > i + 1) {
    return ['', 0]; // named entity (&name;): passed through as-is
  }
  return null;
}
// Is s[i] the start of an entity-like sequence (&name; or &#...;)?
function isEntityLike(s, i) {
  if (s[i] !== '&') return false;
  let j = i + 1;
  if (s[j] === '#') {
    j++;
    if (s[j] === 'x' || s[j] === 'X') j++;
    const st = j;
    while (j < s.length && /[0-9a-fA-F]/.test(s[j])) j++;
    return j > st && j < s.length && s[j] === ';';
  }
  while (j < s.length && /[A-Za-z0-9]/.test(s[j])) j++;
  return j > i + 1 && j < s.length && s[j] === ';';
}

// Escape a URL/title attribute value: keep entity-like &...; as-is, escape
// other & as &amp;, escape < > ".
function escAttr(s) {
  let out = '', start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '&') {
      if (isEntityLike(s, i)) continue;
      out += s.slice(start, i) + '&amp;'; start = i + 1;
    } else if (c === '<') { out += s.slice(start, i) + '&lt;'; start = i + 1; }
    else if (c === '>') { out += s.slice(start, i) + '&gt;'; start = i + 1; }
    else if (c === '"') { out += s.slice(start, i) + '&quot;'; start = i + 1; }
  }
  return out + s.slice(start);
}

// Clean a link destination the way marked does: unescape backslashes,
// percent-encode spaces, < > " ` and non-ASCII, keep entity-like & as-is.
function cleanUrl(dest) {
  let d = unesc(dest);
  return encodeUrlChars(d);
}
function encodeUrlChars(d) {
  let out = '';
  for (let i = 0; i < d.length; i++) {
    const c = d[i];
    const code = d.charCodeAt(i);
    if (c === '&' && isEntityLike(d, i)) { out += c; continue; }
    if (c === ' ') out += '%20';
    else if (c === '"') out += '%22';
    else if (c === '<') out += '%3C';
    else if (c === '>') out += '%3E';
    else if (c === '`') out += '%60';
    else if (code === 0x5c) out += '%5C';
    else if (c === '[') out += '%5B';
    else if (c === ']') out += '%5D';
    else if (code < 0x20 || code === 0x7f) out += '%' + code.toString(16).toUpperCase().padStart(2, '0');
    else if (code > 0x7f) {
      const bytes = new TextEncoder().encode(c);
      for (const b of bytes) out += '%' + b.toString(16).toUpperCase().padStart(2, '0');
    }
    else out += c;
  }
  return out;
}

// Normalize a link label: collapse whitespace runs to one space, trim, lowercase.
function normLabel(s) {
  return s.replace(/\u00df|\u1e9e/g, 'ss').replace(/[ \t\r\n]+/g, ' ').trim().toLowerCase();
}

// ---- inline parsing ----
// Tokens: text (html-escaped already), code, html, br, soft, delim, link, img,
// em, strong, del. Link/image resolution happens during tokenization on the
// raw string; emphasis runs over the token list afterwards.

const SCHEME_RE = /^<([A-Za-z][A-Za-z0-9+.-]{1,31}):([^<>\s]*)>/;
const EMAIL_RE = /^<([A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*)>/;
const TAGNAME_RE = /^[A-Za-z][A-Za-z0-9-]*/;

// Try to read a raw-HTML tag/comment/etc. at s[i] === '<'. Returns end index or -1.
function scanRawHtml(s, i) {
  if (s.startsWith('<!--', i)) {
    if (s.startsWith('<!-->', i)) return i + 5;
    if (s.startsWith('<!--->', i)) return i + 6;
    const e = s.indexOf('-->', i + 4);
    return e === -1 ? -1 : e + 3;
  }
  if (s.startsWith('<?', i)) {
    const e = s.indexOf('?>', i + 2);
    return e === -1 ? -1 : e + 2;
  }
  if (s.startsWith('<![CDATA[', i)) {
    const e = s.indexOf(']]>', i + 9);
    return e === -1 ? -1 : e + 3;
  }
  if (s.startsWith('<!', i) && i + 2 < s.length && /[A-Za-z]/.test(s[i + 2])) {
    const e = s.indexOf('>', i + 2);
    return e === -1 ? -1 : e + 1;
  }
  let j = i + 1, closing = false;
  if (s[j] === '/') { closing = true; j++; }
  const m = TAGNAME_RE.exec(s.slice(j, j + 40));
  if (!m) return -1;
  j += m[0].length;
  if (closing) {
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
    return (j < s.length && s[j] === '>') ? j + 1 : -1;
  }
  for (;;) {
    let sawWs = false;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) { j++; sawWs = true; }
    if (j >= s.length) return -1;
    if (s[j] === '>') return j + 1;
    if (s[j] === '/' && s[j + 1] === '>') return j + 2;
    if (!sawWs) return -1;
    // attribute name
    if (!/[A-Za-z_:]/.test(s[j])) return -1;
    while (j < s.length && /[A-Za-z0-9_.:-]/.test(s[j])) j++;
    let k = j;
    while (k < s.length && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) k++;
    if (s[k] === '=') {
      j = k + 1;
      while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
      if (j >= s.length) return -1;
      const q = s[j];
      if (q === '"' || q === "'") {
        const e = s.indexOf(q, j + 1);
        if (e === -1) return -1;
        j = e + 1;
      } else {
        while (j < s.length && !/[\s"'=<>`]/.test(s[j])) j++;
        if (j >= s.length) return -1;
      }
    }
  }
}

// Find the index of the ']' matching the '[' at `open` in raw string s,
// skipping code spans and escaped brackets. Returns -1.
function findMatchingBracket(s, open) {
  let depth = 0;
  for (let i = open + 1; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length && PUNCT.has(s[i + 1])) { i++; continue; }
    if (c === '`') {
      let n = 0;
      while (i + n < s.length && s[i + n] === '`') n++;
      const close = s.indexOf('`'.repeat(n), i + n);
      if (close === -1) return -1;
      i = close + n - 1;
      continue;
    }
    if (c === '[') depth++;
    else if (c === ']') {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
}

// Parse "(dest title)" starting at s[i] === '('. Returns {dest, title, end} or null.
function parseInlineLink(s, i) {
  let j = i + 1;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  let dest = '';
  if (j < s.length && s[j] === '<') {
    let e = -1;
    for (let k = j + 1; k < s.length; k++) {
      if (s[k] === '\n') break;
      if (s[k] === '>' && s[k - 1] !== '\\') { e = k; break; }
      if (s[k] === '\\') k++;
    }
    if (e === -1) return null;
    dest = s.slice(j + 1, e);
    j = e + 1;
  } else {
    let depth = 0, k = j;
    while (k < s.length) {
      const c = s[k];
      if (c === '\\' && k + 1 < s.length && PUNCT.has(s[k + 1])) { k += 2; continue; }
      if (c === '(') depth++;
      else if (c === ')') { if (depth === 0) break; depth--; }
      else if (c === ' ' || c === '\t' || c === '\n') break;
      k++;
    }
    dest = s.slice(j, k);
    j = k;
  }
  const afterDest = j;
  while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  let title = null;
  if (j < s.length && s[j] !== ')') {
    if (j === afterDest) return null;
    const q = s[j];
    if (q === '"' || q === "'") {
      let e = -1;
      for (let k = j + 1; k < s.length; k++) {
        if (s[k] === '\\') { k++; continue; }
        if (s[k] === q) { e = k; break; }
        if (s[k] === '\n' && s[k + 1] === '\n') break;
      }
      if (e === -1) return null;
      title = unesc(s.slice(j + 1, e));
      j = e + 1;
    } else if (q === '(') {
      let depth = 1, k = j + 1;
      while (k < s.length && depth > 0) {
        if (s[k] === '\\' && k + 1 < s.length) { k += 2; continue; }
        if (s[k] === '(') depth++;
        else if (s[k] === ')') depth--;
        k++;
      }
      if (depth !== 0) return null;
      title = unesc(s.slice(j + 1, k - 1));
      j = k;
    } else return null;
    while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) j++;
  }
  if (j >= s.length || s[j] !== ')') return null;
  return { dest, title, end: j + 1 };
}

// Parse a label "[...]" starting at s[i] === '['. Returns {label, end} or null.
function parseLabel(s, i) {
  let j = i + 1, depth = 0;
  while (j < s.length) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && PUNCT.has(s[j + 1])) { j += 2; continue; }
    if (c === '[') depth++;
    else if (c === ']') { if (depth === 0) return { label: s.slice(i + 1, j), end: j + 1 }; depth--; }
    j++;
  }
  return null;
}

// Try to resolve a link whose text runs s[textStart..closeIdx) and whose
// closing bracket is at closeIdx. Returns {href, title, end} or null.
function tryLink(s, closeIdx, textStart, refs) {
  const inner = s.slice(textStart, closeIdx);
  const next = s[closeIdx + 1];
  if (next === '(') {
    const r = parseInlineLink(s, closeIdx + 1);
    if (r) return { href: cleanUrl(r.dest), title: r.title, end: r.end };
  }
  if (next === '[') {
    const lab = parseLabel(s, closeIdx + 1);
    if (!lab) return null;
    const key = lab.label === '' ? normLabel(inner) : normLabel(lab.label);
    const ref = refs.get(key);
    if (!ref) return null;
    return { href: cleanUrl(ref.dest), title: ref.title, end: lab.end };
  }
  const ref = refs.get(normLabel(inner));
  if (!ref) return null;
  return { href: cleanUrl(ref.dest), title: ref.title, end: closeIdx + 1 };
}

// Plain-text rendering of nodes (for image alt text).
function nodesToText(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    else if (n.t === 'code') out += n.s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    else if (n.t === 'em' || n.t === 'strong' || n.t === 'del' || n.t === 'link') out += nodesToText(n.children);
    else if (n.t === 'img') out += n.alt || '';
    else if (n.t === 'soft') out += '\n';
    else if (n.t === 'br') out += '\n';
    else if (n.t === 'delim') out += n.ch.repeat(n.n);
  }
  return out;
}

// Extended autolink (GFM): www. domains, scheme:// URLs, mailto:/xmpp: emails,
// and bare emails. Returns {href, text, end} or null.
const EMAIL_RE2 = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/;
const TRAIL_PUNCT = '?!.,:;*_~\'"';
function cleanAutolinkUrl(text) {
  // Strip trailing punctuation and unmatched ')' until stable; a trailing
  // ';' that completes an &name; entity drops the whole entity.
  for (;;) {
    if (text.length === 0) return text;
    const last = text[text.length - 1];
    if (last === ')') {
      let open = 0, close = 0;
      for (let i = 0; i < text.length; i++) {
        if (text[i] === '(') open++;
        else if (text[i] === ')') close++;
      }
      if (close > open) { text = text.slice(0, -1); continue; }
      return text;
    }
    if (last === ';') {
      const m = /&[A-Za-z0-9]+;$/.exec(text);
      if (m) { text = text.slice(0, m.index); continue; }
      text = text.slice(0, -1); continue;
    }
    if (TRAIL_PUNCT.includes(last)) { text = text.slice(0, -1); continue; }
    return text;
  }
}
function tryExtAutolink(s, i) {
  if (inRawA) return null;
  const prev = i === 0 ? '' : s[i - 1];
  const boundary = prev === '' || isSpace(prev) || (isPunct(prev) && prev !== '/' && prev !== '@' && prev !== '.' && prev !== '_' && prev !== '%' && prev !== '+' && prev !== '-');
  if (!boundary) return null;
  const rest = (from) => {
    let e = from;
    while (e < s.length) {
      const ch = s[e];
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '<' || ch === '>') break;
      e++;
    }
    return s.slice(from, e);
  };
  // scheme:// (http, https, ftp only; case-insensitive)
  const sm = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(s.slice(i, i + 40));
  if (sm) {
    const scheme = sm[0].slice(0, -3).toLowerCase();
    if (scheme === 'http' || scheme === 'https' || scheme === 'ftp') {
      const text = cleanAutolinkUrl(sm[0] + rest(i + sm[0].length));
      if (text.length > sm[0].length) return { href: text, text, end: i + text.length };
      return null;
    }
  }
  // mailto: / xmpp: + email + optional single /segment
  const xm = /^(mailto|xmpp):/i.exec(s.slice(i, i + 8));
  if (xm) {
    const em = EMAIL_RE2.exec(s.slice(i + xm[0].length, i + 200));
    if (em && em[0].endsWith('-')) return null;
    if (em) {
      let text = xm[0] + em[0];
      const pm = /^\/[A-Za-z0-9@]+(?:\.[A-Za-z0-9@]+)*/.exec(s.slice(i + text.length));
      if (pm) text += pm[0];
      const nextCh = s[i + text.length];
      if (nextCh === '-' || nextCh === '_') return null;
      return { href: text, text, end: i + text.length };
    }
  }
  // www. domain + optional path
  if (s.startsWith('www.', i)) {
    const m = /^www\.(?:[A-Za-z0-9-]+\.)+[A-Za-z0-9-]+/.exec(s.slice(i, i + 300));
    if (!m) return null;
    const text = cleanAutolinkUrl(m[0] + rest(i + m[0].length));
    if (text.length <= 4) return null;
    return { href: 'http://' + text, text, end: i + text.length };
  }
  // bare email
  const at = s.indexOf('@', i);
  if (at !== -1 && at - i < 64) {
    const m = EMAIL_RE2.exec(s.slice(i, i + 120));
    if (m) {
      const text = m[0];
      if (text.endsWith('-')) return null;
      const nextCh = s[i + text.length];
      if (nextCh === '-' || nextCh === '_') return null;
      if (text.length > 3) return { href: 'mailto:' + text, text, end: i + text.length };
    }
  }
  return null;
}

// Tokenize one inline string. Links are resolved here on the raw string
// (recursively, so an inner link beats an outer one); emphasis runs after.
function tokenizeInline(s, refs, inLink) {
  const toks = [];
  const openers = [];
  let buf = '';
  const flush = () => { if (buf) { toks.push({ t: 'text', s: buf }); buf = ''; } };
  const pushEsc = (ch) => {
    if (ch === '&') buf += '&amp;';
    else if (ch === '<') buf += '&lt;';
    else if (ch === '>') buf += '&gt;';
    else if (ch === '"') buf += '&quot;';
    else if (ch === "'") buf += '&#39;';
    else buf += ch;
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\') {
      const n = s[i + 1];
      if (n === '\n') { flush(); toks.push({ t: 'br' }); i += 2; while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++; continue; }
      if (n !== undefined && PUNCT.has(n)) { pushEsc(n); i += 2; continue; }
      buf += '\\'; i++; continue;
    }
    if (c === '`') {
      let n = 0;
      while (i + n < s.length && s[i + n] === '`') n++;
      let close = -1, j = i + n;
      while (j < s.length) {
        if (s[j] === '`') {
          let r = 0;
          while (j + r < s.length && s[j + r] === '`') r++;
          if (r === n) { close = j; break; }
          j += r;
        } else j++;
      }
      if (close === -1) {
        // An unclosed backtick run inside link text kills the enclosing
        // link(s) -- unless a LATER unmatched backtick run sits between
        // it and the link-closing ']' (e.g. `` ``fixes` ``: the lone
        // single backtick rescues the link). A later run that itself
        // forms a code span does not rescue it.
        if (openers.length && !openers[openers.length - 1].tickDone) {
          let kills = true;
          for (let q = i + n; q < s.length; q++) {
            if (s[q] === '\\') { q++; continue; }
            if (s[q] === ']') break;
            if (s[q] === '`') {
              let r = 0;
              while (q + r < s.length && s[q + r] === '`') r++;
              // does this later run have a matching close before ']'?
              let matched = false;
              for (let w = q + r; w < s.length; w++) {
                if (s[w] === '\\') { w++; continue; }
                if (s[w] === ']') break;
                if (s[w] === '`') {
                  let rr = 0;
                  while (w + rr < s.length && s[w + rr] === '`') rr++;
                  if (rr === r) { matched = true; break; }
                  w += rr - 1;
                }
              }
              if (!matched) kills = false;
              break;
            }
          }
          if (kills) for (const o of openers) o.dead = true;
          for (const o of openers) o.tickDone = true;
        }
        buf += '`'.repeat(n); i += n; continue;
      }
      if (openers.length && close !== -1) {
        // A code span that would span lines must not swallow the
        // link-closing ']': if a ']' sits between the run and a close on a
        // later line, the backticks stay literal so the link can form.
        // (Single-line code spans containing ']' still form, per spec.)
        const seg = s.slice(i + n, close);
        if (seg.includes('\n') && seg.includes(']')) { buf += '`'.repeat(n); i += n; continue; }
      }
      let content = s.slice(i + n, close).replace(/\n/g, ' ');
      if (content.length >= 2 && content[0] === ' ' && content[content.length - 1] === ' ' && /[^ ]/.test(content)) content = content.slice(1, -1);
      flush();
      toks.push({ t: 'code', s: escAmpLtGt(content) });
      i = close + n;
      continue;
    }
    if (c === '<') {
      let m = SCHEME_RE.exec(s.slice(i, i + 400));
      if (m) {
        flush();
        const inner = m[1] + ':' + m[2];
        toks.push({ t: 'link', href: escAttr(encodeUrlChars(inner)), title: null, auto: true, children: [{ t: 'text', s: escAmpLtGt(inner) }] });
        i += m[0].length;
        continue;
      }
      m = EMAIL_RE.exec(s.slice(i, i + 400));
      if (m) {
        flush();
        toks.push({ t: 'link', href: escAttr(encodeUrlChars('mailto:' + m[1])), title: null, auto: true, children: [{ t: 'text', s: escAmpLtGt(m[1]) }] });
        i += m[0].length;
        continue;
      }
      const e = scanRawHtml(s, i);
      if (e !== -1) {
        const html = s.slice(i, e);
        // <a> / </a> inside a link's text (re-parsed) does not touch the
        // document-level flag; only the main inline flow does.
        if (!inLink) {
          if (/^<\/a\s*>/i.test(html)) inRawA = false;
          else if (/^<a(?=[\s>])/i.test(html) && !/\/\s*>$/.test(html)) inRawA = true;
        }
        flush(); toks.push({ t: 'html', s: html }); i = e; continue;
      }
      pushEsc('<'); i++; continue;
    }
    if (c === '&') {
      const ent = tryEntity(s, i);
      if (ent) {
        if (ent[1] === 0) {
          const semi = s.indexOf(';', i);
          buf += s.slice(i, semi + 1);
          i = semi + 1;
        } else {
          const ch = ent[0];
          if (ch === '&') buf += '&amp;';
          else if (ch === '<') buf += '&lt;';
          else if (ch === '>') buf += '&gt;';
          else if (ch === '"') buf += '&quot;';
          else if (ch === "'") buf += '&#39;';
          else buf += ch;
          i += ent[1];
        }
        continue;
      }
      buf += '&amp;'; i++; continue;
    }
    if (c === '[' || (c === '!' && s[i + 1] === '[')) {
      const img = c === '!';
      flush();
      if (img) {
        toks.push({ t: 'text', s: '!' });
        toks.push({ t: 'text', s: '[' });
        openers.push({ pos: i + 1, img: true, toksIdx: toks.length - 2, textStart: i + 2, savedRawA: inRawA, tickDone: false });
        i += 2;
      } else {
        toks.push({ t: 'text', s: '[' });
        openers.push({ pos: i, img: false, toksIdx: toks.length - 1, textStart: i + 1, savedRawA: inRawA, tickDone: false });
        i++;
      }
      continue;
    }
    if (c === ']') {
      const opener = openers.length ? openers[openers.length - 1] : null;
      let formed = false;
      if (opener && !opener.dead) {
        const link = tryLink(s, i, opener.textStart, refs);
        if (link) {
          const inner = s.slice(opener.textStart, i);
          const children = parseInlineNodes(inner, refs, true);
          if (opener.img || !hasLink(children)) {
            flush();
            toks.length = opener.toksIdx;
            if (opener.img) toks.push({ t: 'img', src: link.href, title: link.title, alt: nodesToText(children) });
            else toks.push({ t: 'link', href: link.href, title: link.title, children });
            inRawA = opener.savedRawA;
            openers.pop();
            i = link.end;
            formed = true;
          }
        }
        if (!formed) openers.pop();
      }
      if (!formed) { buf += ']'; i++; }
      continue;
    }
    if (c === '*' || c === '_' || c === '~') {
      let n = 0;
      while (i + n < s.length && s[i + n] === c) n++;
      if (c === '~' && n >= 3) { buf += '~'.repeat(n); i += n; continue; }
      const prev = i === 0 ? '' : s[i - 1];
      const next = i + n >= s.length ? '' : s[i + n];
      const prevSpace = prev === '' || isSpace(prev);
      const nextSpace = next === '' || isSpace(next);
      const prevPunct = prev !== '' && isPunct(prev);
      const nextPunct = next !== '' && isPunct(next);
      const leftFlank = !nextSpace && (!nextPunct || prevSpace || prevPunct);
      const rightFlank = !prevSpace && (!prevPunct || nextSpace || nextPunct);
      let canOpen, canClose;
      if (c === '_') {
        canOpen = leftFlank && (!rightFlank || prevPunct);
        canClose = rightFlank && (!leftFlank || nextPunct);
      } else {
        canOpen = leftFlank;
        canClose = rightFlank;
      }
      flush();
      toks.push({ t: 'delim', ch: c, n, canOpen, canClose });
      i += n;
      continue;
    }
    if (c === '\n') {
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        toks.push({ t: 'br' });
        i++;
        while (i < s.length && (s[i] === ' ' || s[i] === '\t')) i++;
      } else {
        flush();
        toks.push({ t: 'soft' });
        i++;
      }
      continue;
    }
    if ((c >= '0' && c <= '9') || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
      // Hoisted boundary test: an autolink cannot start mid-word (prev is
      // alphanumeric) or after / @ . _ % + - . tryExtAutolink re-checks the
      // full boundary rule, so this may only skip calls, never valid ones.
      let boundary = false;
      if (i === 0) boundary = true;
      else {
        const pc = s.charCodeAt(i - 1);
        if (pc === 32 || pc === 9 || pc === 10) boundary = true;
        else if (!((pc >= 48 && pc <= 57) || (pc >= 65 && pc <= 90) || (pc >= 97 && pc <= 122))) {
          const pch = s[i - 1];
          if (pch !== '/' && pch !== '@' && pch !== '.' && pch !== '_' && pch !== '%' && pch !== '+' && pch !== '-') boundary = true;
        }
      }
      const a = (boundary && openers.length === 0 && !inLink) ? tryExtAutolink(s, i) : null;
      if (a) {
        flush();
        toks.push({ t: 'link', href: escAttr(encodeUrlChars(a.href)), title: null, auto: true, children: [{ t: 'text', s: escAmpLtGt(a.text) }] });
        i = a.end;
        continue;
      }
    }
    pushEsc(c);
    i++;
  }
  flush();
  return toks;
}

function hasLink(nodes) {
  for (const n of nodes) {
    if (n.t === 'link' && !n.auto) return true;
    if (n.children && hasLink(n.children)) return true;
  }
  return false;
}

// CommonMark delimiter-stack emphasis resolution over a token list.
function resolveEmphasis(toks) {
  const stack = [];
  let k = 0;
  while (k < toks.length) {
    const d = toks[k];
    if (d.t !== 'delim') { k++; continue; }
    let matched = false;
    if (d.canClose && d.n > 0) {
      for (let si = stack.length - 1; si >= 0; si--) {
        const oidx = stack[si];
        const o = toks[oidx];
        if (!o || o.t !== 'delim' || o.ch !== d.ch || o.n === 0 || !o.canOpen) continue;
        const odd = (o.canOpen && o.canClose) || (d.canOpen && d.canClose);
        if (odd && (o.n + d.n) % 3 === 0 && (o.n % 3 !== 0 || d.n % 3 !== 0)) continue;
        let use = 0;
        if (d.ch === '~') { if (o.n === d.n && o.n <= 2) use = o.n; }
        else use = (o.n >= 2 && d.n >= 2) ? 2 : 1;
        if (use === 0) continue;
        const inner = toks.slice(oidx + 1, k);
        const node = { t: d.ch === '~' ? 'del' : (use === 2 ? 'strong' : 'em'), children: inner };
        for (let sj = stack.length - 1; sj >= 0; sj--) if (stack[sj] > oidx && stack[sj] < k) stack.splice(sj, 1);
        o.n -= use;
        d.n -= use;
        const repl = [];
        if (o.n > 0) repl.push(o);
        repl.push(node);
        if (d.n > 0) repl.push(d);
        toks.splice(oidx, k - oidx + 1, ...repl);
        if (o.n === 0) { const p = stack.indexOf(oidx); if (p !== -1) stack.splice(p, 1); }
        if (d.n > 0 && d.canClose) k = oidx + repl.length - 1;
        else {
          if (d.n > 0 && d.canOpen) stack.push(oidx + repl.length - 1);
          k = oidx + repl.length;
        }
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (d.canOpen && d.n > 0) stack.push(k);
      k++;
    }
  }
  return toks;
}

function renderNodes(nodes) {
  let out = '';
  for (const n of nodes) {
    if (n.t === 'text') out += n.s;
    else if (n.t === 'code') out += '<code>' + n.s + '</code>';
    else if (n.t === 'html') out += n.s;
    else if (n.t === 'br') out += '<br>';
    else if (n.t === 'soft') out += '\n';
    else if (n.t === 'delim') out += n.ch.repeat(n.n);
    else if (n.t === 'em') out += '<em>' + renderNodes(n.children) + '</em>';
    else if (n.t === 'strong') out += '<strong>' + renderNodes(n.children) + '</strong>';
    else if (n.t === 'del') out += '<del>' + renderNodes(n.children) + '</del>';
    else if (n.t === 'link') out += '<a href="' + escAttr(n.href) + '"' + (n.title !== null && n.title !== undefined ? ' title="' + escAttr(n.title) + '"' : '') + '>' + renderNodes(n.children) + '</a>';
    else if (n.t === 'img') out += '<img src="' + escAttr(n.src) + '" alt="' + escAttr(n.alt) + '"' + (n.title ? ' title="' + escAttr(n.title) + '"' : '') + '>';
  }
  return out;
}

function parseInlineNodes(s, refs, inLink) {
  return resolveEmphasis(tokenizeInline(s, refs, inLink));
}
let collectOnly = false;
let inputEndsNL = false;
// Document-level: an unclosed inline <a> tag suppresses GFM bare autolinks
// for the rest of the document (marked's autolink extension tracks this).
let inRawA = false;
function parseInline(s, refs) {
  if (collectOnly) return '';
  return renderNodes(parseInlineNodes(s, refs));
}

// ---- block parsing ----
function firstNW(line) {
  let i = 0;
  while (i < line.length && (line[i] === ' ' || line[i] === '\t')) i++;
  return i;
}

// Skip spaces/tabs, then at most one newline (not across a blank line).
// Returns new index or -1.
function skipWs1NL(txt, j) {
  while (j < txt.length && (txt[j] === ' ' || txt[j] === '\t')) j++;
  if (txt[j] === '\n') {
    let k = j + 1;
    while (k < txt.length && (txt[k] === ' ' || txt[k] === '\t')) k++;
    if (txt[k] === '\n' || k >= txt.length) return j; // blank line: don't cross
    return k;
  }
  return j;
}

// Try to parse a link reference definition starting at lines[i].
// Returns lines consumed (0 when not a definition). Stores into refs.
function tryRefDef(lines, i, refs) {
  const line = lines[i];
  if (indentCols(line) > 3) return 0;
  let end = i;
  while (end < lines.length && !isBlankStr(lines[end]) && end - i < 64) end++;
  const txt = lines.slice(i, end).join('\n');
  let p = firstNW(line);
  if (txt[p] !== '[') return 0;
  let j = p + 1, label = '';
  while (j < txt.length) {
    const ch = txt[j];
    if (ch === '\\' && j + 1 < txt.length && PUNCT.has(txt[j + 1])) { label += txt[j] + txt[j + 1]; j += 2; continue; }
    if (ch === '[') return 0;
    if (ch === ']') break;
    label += ch; j++;
  }
  if (j >= txt.length || txt[j] !== ']' || label.length === 0 || label.length > 999) return 0;
  j++;
  if (txt[j] !== ':') return 0;
  j++;
  j = skipWs1NL(txt, j);
  if (j === -1 || j >= txt.length) return 0;
  // destination
  let dest = '';
  if (txt[j] === '<') {
    let e = -1;
    for (let k = j + 1; k < txt.length; k++) {
      if (txt[k] === '\n' && txt[k + 1] === '\n') break;
      if (txt[k] === '>' && txt[k - 1] !== '\\') { e = k; break; }
      if (txt[k] === '\\') k++;
    }
    if (e === -1) return 0;
    const inner = txt.slice(j + 1, e);
    dest = inner.replace(/\n/g, '');
    j = e + 1;
  } else {
    let depth = 0, k = j;
    while (k < txt.length) {
      const ch = txt[k];
      if (ch === '\\' && k + 1 < txt.length && PUNCT.has(txt[k + 1])) { k += 2; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { if (depth === 0) break; depth--; }
      else if (ch === ' ' || ch === '\t' || ch === '\n') break;
      k++;
    }
    if (k === j) return 0;
    dest = txt.slice(j, k);
    j = k;
  }
  // optional title on the same line or the next one; it must be separated
  // from the destination by whitespace (or a line ending), and its newlines
  // are preserved. A malformed title on a following line leaves the
  // definition standing without a title; a same-line one kills it.
  let title = null, endPos = j;
  let t = j, sawSep = false;
  while (t < txt.length && (txt[t] === ' ' || txt[t] === '\t')) { t++; sawSep = true; }
  if (t < txt.length && txt[t] === '\n') {
    const t2 = skipWs1NL(txt, j);
    if (t2 !== -1 && t2 !== j && t2 < txt.length) { t = t2; sawSep = true; }
  }
  const titleOnNextLine = txt.slice(j, t).includes('\n');
  if (sawSep && t < txt.length && (txt[t] === '"' || txt[t] === "'" || txt[t] === '(')) {
    const q = txt[t];
    let titleEnd = -1, titleVal = null;
    if (q === '(') {
      let depth = 1, k = t + 1;
      while (k < txt.length && depth > 0) {
        if (txt[k] === '\\' && k + 1 < txt.length) { k += 2; continue; }
        if (txt[k] === '(') depth++;
        else if (txt[k] === ')') depth--;
        k++;
      }
      if (depth === 0) { titleVal = unesc(txt.slice(t + 1, k - 1)); titleEnd = k; }
    } else {
      let k = t + 1, ok = false;
      while (k < txt.length) {
        if (txt[k] === '\\' && k + 1 < txt.length) { k += 2; continue; }
        if (txt[k] === q) { ok = true; break; }
        if (txt[k] === '\n' && txt[k + 1] === '\n') break;
        k++;
      }
      if (ok) { titleVal = unesc(txt.slice(t + 1, k)); titleEnd = k + 1; }
    }
    if (titleEnd === -1) {
      if (!titleOnNextLine) return 0;
    } else {
      let e = titleEnd;
      while (e < txt.length && (txt[e] === ' ' || txt[e] === '\t')) e++;
      if (e < txt.length && txt[e] !== '\n') {
        if (!titleOnNextLine) return 0;
      } else {
        title = titleVal;
        endPos = e;
      }
    }
  }
  // the definition's last line must end after the destination/title
  {
    let e = endPos;
    while (e < txt.length && (txt[e] === ' ' || txt[e] === '\t')) e++;
    if (e < txt.length && txt[e] !== '\n') return 0;
    endPos = e;
  }
  const key = normLabel(label);
  if (key === '') return 0;
  if (!refs.has(key)) refs.set(key, { dest, title });
  let consumed = 1;
  for (let x = 0; x < endPos; x++) if (txt[x] === '\n') consumed++;
  return consumed;
}

function matchFence(content, ind) {
  if (ind > 3) return null;
  const m = /^(`{3,}|~{3,})/.exec(content);
  if (!m) return null;
  const info = content.slice(m[0].length);
  if (m[0][0] === '`' && info.includes('`')) return null;
  return { ch: m[0][0], len: m[0].length, info, ind };
}
function matchAtx(content, ind) {
  if (ind > 3) return null;
  const m = /^(#{1,6})(?:[ \t]+(.*))?$/.exec(content);
  if (!m) return null;
  let text = m[2] === undefined ? '' : m[2];
  text = text.replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else text = text.replace(/[ \t]+#+[ \t]*$/, '').replace(/[ \t]+$/, '');
  return { level: m[1].length, text };
}
function isThematicBreak(content, ind) {
  if (ind > 3) return false;
  return /^([*_-])(?:[ \t]*\1){2,}[ \t]*$/.test(content);
}
function isSetextLine(line) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const c = line.slice(firstNW(line));
  return /^(=+|-+)[ \t]*$/.test(c);
}

const BLOCK_TAGS = new Set('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param section source summary table tbody td tfoot th thead title tr track ul'.split(' '));
const PRE_TAGS = new Set(['script', 'pre', 'style', 'textarea']);

// HTML block start type (0 = none). `forPara` excludes type 7.
function htmlBlockType(content, ind, forPara) {
  if (ind > 3) return 0;
  const s = content;
  const m1 = /^<(script|pre|style|textarea)([ \t>]|$)/i.exec(s);
  if (m1) return 1;
  if (s.startsWith('<!--')) return 2;
  if (s.startsWith('<?')) return 3;
  if (/^<![A-Za-z]/.test(s)) return 4;
  if (s.startsWith('<![CDATA[')) return 5;
  const m6 = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(s);
  if (m6 && BLOCK_TAGS.has(m6[1].toLowerCase())) {
    const after = s[m6[0].length];
    if (after === undefined || after === ' ' || after === '\t' || after === '>' || after === '/') return 6;
  }
  if (!forPara) {
    // type 7: a complete open tag (attributes allowed) or closing tag
    // (no attributes) alone on the line
    if (/^<[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[A-Za-z_:][A-Za-z0-9_.:-]*(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*[ \t]*\/?>[ \t]*$/.test(s)) return 7;
    if (/^<\/[A-Za-z][A-Za-z0-9-]*[ \t]*>[ \t]*$/.test(s)) return 7;
  }
  return 0;
}

function matchList(content, ind) {
  if (ind > 3) return null;
  let m = /^([*+-])(?:[ \t]+(.*))?$/.exec(content);
  if (m && (m[2] !== undefined || content.length === 1)) {
    const markerCols = 1;
    let contentIndent;
    if (m[2] === undefined || m[2] === '') contentIndent = ind + markerCols + 1;
    else {
      const after = content.slice(1);
      let sp = 0, k = 0;
      while (k < after.length && (after[k] === ' ' || after[k] === '\t')) {
        if (after[k] === '\t') sp += 4 - ((ind + markerCols + sp) % 4); else sp += 1;
        k++;
      }
      contentIndent = ind + (sp >= 5 ? markerCols + 1 : markerCols + sp);
      if (sp === 0) return null;
    }
    return { bullet: true, ch: m[1], contentIndent, empty: m[2] === undefined };
  }
  m = /^(\d{1,9})([.)])(?:[ \t]+(.*))?$/.exec(content);
  if (m && (m[3] !== undefined || content.length === m[1].length + 1)) {
    const markerCols = m[1].length + 1;
    let contentIndent;
    if (m[3] === undefined || m[3] === '') contentIndent = ind + markerCols + 1;
    else {
      const after = content.slice(m[1].length + 1);
      let sp = 0, k = 0;
      while (k < after.length && (after[k] === ' ' || after[k] === '\t')) {
        if (after[k] === '\t') sp += 4 - ((ind + markerCols + sp) % 4); else sp += 1;
        k++;
      }
      contentIndent = ind + (sp >= 5 ? markerCols + 1 : markerCols + sp);
      if (sp === 0) return null;
    }
    return { bullet: false, delim: m[2], start: parseInt(m[1], 10), contentIndent, empty: m[3] === undefined };
  }
  return null;
}

function interruptsParagraph(line, inListItem) {
  const ind = indentCols(line);
  const nw = firstNW(line);
  const content = line.slice(nw);
  if (ind <= 3) {
    if (/^#{1,6}(?:[ \t]+|$)/.test(content)) return true;
    if (matchFence(content, ind)) return true;
    if (isThematicBreak(content, ind)) return true;
    if (htmlBlockType(content, ind, true) !== 0) return true;
    if (content[0] === '>') return true;
    const ls = matchList(content, ind);
    if (ls && !ls.empty) {
      if (ls.bullet) return true;
      if (ls.start === 1 || inListItem) return true;
    }
  }
  return false;
}

function startsBlock(line) {
  const ind = indentCols(line);
  const nw = firstNW(line);
  const content = line.slice(nw);
  if (ind > 3) return false;
  if (/^#{1,6}(?:[ \t]+|$)/.test(content)) return true;
  if (matchFence(content, ind)) return true;
  if (isThematicBreak(content, ind)) return true;
  if (htmlBlockType(content, ind, false) !== 0) return true;
  if (content[0] === '>') return true;
  if (matchList(content, ind)) return true;
  return false;
}

// Split a table row line into cells, respecting escapes and code spans.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) { if (s[i + 1] === '|') { cur += '|'; } else { cur += c + s[i + 1]; } i += 2; continue; }
    if (c === '|') { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += c; i++;
  }
  cells.push(cur.trim());
  return cells;
}
function isTableDelim(line) {
  const ind = indentCols(line);
  if (ind > 3) return false;
  const cells = splitRow(line);
  if (cells.length === 0) return false;
  for (const cell of cells) if (!/^\s*:?-+:?\s*$/.test(cell)) return false;
  return true;
}
function parseTable(lines, start, refs) {
  const header = splitRow(lines[start]);
  const delim = splitRow(lines[start + 1]);
  const aligns = delim.map((d) => {
    const t = d.trim();
    if (t.startsWith(':') && t.endsWith(':')) return 'center';
    if (t.endsWith(':')) return 'right';
    if (t.startsWith(':')) return 'left';
    return null;
  });
  let out = '<table>\n<thead>\n<tr>\n';
  for (let i = 0; i < header.length; i++) {
    const a = aligns[i];
    out += '<th' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(header[i], refs) + '</th>\n';
  }
  out += '</tr>\n</thead>\n';
  let k = start + 2, first = true, rows = '';
  // A table row ends only on an empty/spaces-only line or a block start;
  // a tab-only line is a (blank-cell) row, and a line without pipes is a
  // single-cell row.
  while (k < lines.length && !/^ *$/.test(lines[k]) && !startsBlock(lines[k])) {
    const row = splitRow(lines[k]);
    rows += first ? '<tr>\n' : '</tr>\n<tr>\n';
    first = false;
    for (let i = 0; i < header.length; i++) {
      const cell = i < row.length ? row[i] : '';
      const a = aligns[i];
      rows += '<td' + (a ? ' align="' + a + '"' : '') + '>' + parseInline(cell, refs) + '</td>\n';
    }
    k++;
  }
  if (rows) out += '<tbody>' + rows + '</tr>\n</tbody>';
  out += '</table>\n';
  return { html: out, next: k };
}

function parseParagraph(lines, i, refs, tight, lazy, inListItem) {
  let j = i;
  while (j < lines.length) {
    const c = tryRefDef(lines, j, refs);
    if (c === 0) break;
    j += c;
  }
  if (j >= lines.length || isBlankStr(lines[j])) return { html: '', next: j, para: false };
  if (startsBlock(lines[j])) return { html: '', next: j, para: false };
  const start = j;
  let k = j;
  while (k < lines.length) {
    const l = lines[k];
    if (isBlankStr(l) && !(lazy && lazy.has(k))) break;
    if (k > start) {
      if (isSetextLine(l)) break;
      if (!(lazy && lazy.has(k)) && interruptsParagraph(l, inListItem)) break;
    }
    k++;
  }
  if (k - start >= 1 && start + 1 < lines.length && isTableDelim(lines[start + 1]) && (lines[start].includes('|') || lines[start + 1].includes('|')) && splitRow(lines[start]).length === splitRow(lines[start + 1]).length) {
    return parseTable(lines, start, refs);
  }
  if (k < lines.length && isSetextLine(lines[k])) {
    const level = lines[k].slice(firstNW(lines[k]))[0] === '=' ? 1 : 2;
    const text = lines.slice(start, k).join('\n').replace(/^[ \t\n]+/, '').replace(/[ \t\n]+$/, '');
    return { html: '<h' + level + '>' + parseInline(text, refs) + '</h' + level + '>\n', next: k + 1, para: false };
  }
  const text = lines.slice(start, k).join('\n');
  if (tight) return { html: parseInline(text, refs), next: k, para: true };
  return { html: '<p>' + parseInline(text, refs) + '</p>\n', next: k, para: true };
}

// Strip up to n columns of leading whitespace (spaces/tabs) only, stopping
// at the first non-whitespace char. Used for list continuation lines.
function stripWsCols(line, n, baseCol) {
  let cut = 0, col = baseCol === undefined ? 0 : baseCol, i = 0, prefix = '';
  while (i < line.length && cut < n) {
    const ch = line[i];
    if (ch === ' ') { cut += 1; col += 1; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (cut + w > n) { prefix = ' '.repeat(cut + w - n); cut = n; col += w; i++; break; }
      cut += w; col += w; i++;
    } else break;
  }
  return prefix + line.slice(i);
}

// Character index in `line` where column `target` is reached (-1 if a tab
// straddles it). Used to cut a list item's first line after its marker.
function indexAtCol(line, target) {
  let col = 0, i = 0;
  while (i < line.length && col < target) {
    if (line[i] === '\t') {
      const w = 4 - (col % 4);
      if (col + w > target) return -1;
      col += w; i++;
    } else { col += 1; i++; }
  }
  return i;
}

// ---- lists ----
function parseList(lines, i, refs) {
  const n = lines.length;
  const first = matchList(lines[i].slice(firstNW(lines[i])), indentCols(lines[i]));
  const isBullet = first.bullet;
  const items = [];
  let loose = false;
  let idx = i;
  while (idx < n) {
    const l = lines[idx];
    if (isThematicBreak(l.slice(firstNW(l)), indentCols(l))) break;
    const st = matchList(l.slice(firstNW(l)), indentCols(l));
    if (!st || st.bullet !== isBullet || (isBullet ? st.ch !== first.ch : st.delim !== first.delim)) break;
    const item = [];
    const itemLazy = new Set();
    item.push(stripCols(l, st.contentIndent, undefined, true, true));
    idx++;
    while (idx < n) {
      const l2 = lines[idx];
      if (isBlankStr(l2)) {
        let k = idx + 1;
        while (k < n && isBlankStr(lines[k])) k++;
        if (k >= n) { idx = k; break; }
        const l3 = lines[k];
        const st3 = matchList(l3.slice(firstNW(l3)), indentCols(l3));
        const belongs = indentCols(l3) >= st.contentIndent;
        if (!belongs && !(st3 && st3.bullet === isBullet && (isBullet ? st3.ch === first.ch : st3.delim === first.delim))) {
          break;
        }
        if (!belongs && st3 && st3.bullet === isBullet && (isBullet ? st3.ch === first.ch : st3.delim === first.delim)) loose = true;
        else if (item.every(isBlankStr)) break;
        while (idx < k) { item.push(''); idx++; }
        continue;
      }
      if (indentCols(l2) >= st.contentIndent) { item.push(stripCols(l2, st.contentIndent, undefined, false, true)); idx++; continue; }
      const st2 = matchList(l2.slice(firstNW(l2)), indentCols(l2));
      if (st2 && st2.bullet === isBullet && (isBullet ? st2.ch === first.ch : st2.delim === first.delim)) break;
      if (item.length > 0 && !isBlankStr(item[item.length - 1]) && !startsBlock(l2)) {
        if (isSetextLine(l2)) {
          if (!lastBlockAllowsLazy(item)) break;
          itemLazy.add(item.length);
          item.push('    ' + l2);
        } else {
          itemLazy.add(item.length);
          item.push(indentCols(l2) >= 4 ? stripCols(l2, 4) : l2);
        }
        idx++;
        continue;
      }
      break;
    }
    while (item.length && isBlankStr(item[item.length - 1])) item.pop();
    items.push({ lines: item, lazy: itemLazy });
  }
  const tag = isBullet ? 'ul' : 'ol';
  let out = '<' + tag + (isBullet ? '' : (first.start !== 1 ? ' start="' + first.start + '"' : '')) + '>\n';
  const rendered = [];
  for (const itemLines of items) {
    const r = renderItem(itemLines, refs, true);
    rendered.push(r);
    if (r.blankSep) loose = true;
  }
  if (loose && !collectOnly) {
    for (let j = 0; j < items.length; j++) rendered[j] = renderItem(items[j], refs, false);
  }
  for (const r of rendered) out += '<li>' + r.html + '</li>\n';
  out += '</' + tag + '>\n';
  return { html: out, next: idx };
}

function renderItem(item, refs, tight) {
  let checkbox = '';
  let lines = item.lines;
  const tm = /^\[([ xX])\](?:[ \t]+(.*))?$/.exec(item.lines[0] ?? '');
  if (tm) {
    const checked = tm[1] === 'x' || tm[1] === 'X';
    checkbox = checked ? '<input checked="" disabled="" type="checkbox">' : '<input disabled="" type="checkbox">';
    lines = item.lines.slice();
    lines[0] = tm[2] ?? '';
  }
  const r = parseBlocks(lines, refs, tight, undefined, item.lazy, true);
  let inner = r.html;
  if (checkbox) {
    if (inner.startsWith('<p>')) inner = '<p>' + checkbox + ' ' + inner.slice(3);
    else inner = checkbox + ' ' + inner;
  }
  return { html: inner, blankSep: r.blankSep };
}

// ---- blockquotes ----
function isQuoteLine(l) {
  const ind = indentCols(l);
  return ind <= 3 && l.slice(firstNW(l))[0] === '>';
}
function stripQuote(l) {
  const nw = firstNW(l);
  const after = l.slice(nw + 1);
  if (after[0] === ' ' || after[0] === '\t') return stripCols(after, 1, indentCols(l) + 1, false, true);
  return after;
}
// True when a lazy continuation line may extend the blocks in `lines`:
// the last block must be a paragraph (or a container whose innermost
// paragraph is open) — not a code block, heading, hr, or HTML block.
function lastBlockAllowsLazy(lines) {
  let start = 0;
  for (let i = lines.length - 1; i >= 0; i--) if (isBlankStr(lines[i])) { start = i + 1; break; }
  const tail = lines.slice(start);
  let blockStart = 0;
  let inFence = null;
  for (let i = 0; i < tail.length; i++) {
    const l = tail[i];
    const ind = indentCols(l);
    const content = l.slice(firstNW(l));
    if (inFence) {
      const f = matchFence(content, ind);
      if (f && f.ch === inFence.ch && f.len >= inFence.len) { inFence = null; blockStart = i + 1; }
      continue;
    }
    const f = matchFence(content, ind);
    if (f) { inFence = f; continue; }
    if (isSetextLine(l)) { blockStart = i + 1; continue; }
    if (ind <= 3 && (matchAtx(content, ind) || isThematicBreak(content, ind) || htmlBlockType(content, ind, true) !== 0)) { blockStart = i + 1; continue; }
  }
  if (inFence) return false;
  const cur = tail.slice(blockStart);
  if (cur.length === 0) return false;
  if (indentCols(cur[0]) >= 4) return false;
  return true;
}

function parseBlockquote(lines, i, refs) {
  const inner = [];
  const innerLazy = new Set();
  let idx = i;
  while (idx < lines.length) {
    const l = lines[idx];
    if (isBlankStr(l)) break;
    if (isQuoteLine(l)) {
      const qc = stripQuote(l);
      inner.push(qc);
      if (qc !== '' && isBlankStr(qc) && inner.length > 1 && !isBlankStr(inner[inner.length - 2])) innerLazy.add(inner.length - 1);
      idx++;
      continue;
    }
    if (inner.length > 0 && lastBlockAllowsLazy(inner) && !startsBlock(l)) {
      innerLazy.add(inner.length);
      inner.push(isSetextLine(l) ? '    ' + l : (indentCols(l) >= 4 ? stripCols(l, 4, undefined, false, true) : l));
      idx++;
      continue;
    }
    break;
  }
  return { html: '<blockquote>\n' + parseBlocks(inner, refs, false, undefined, innerLazy, false).html + '</blockquote>\n', next: idx };
}

// ---- HTML blocks ----
function parseHtmlBlock(lines, i, type, isTop) {
  const start = i;
  let k = i;
  if (type === 1) {
    const tag = /<\/?(script|pre|style|textarea)/i.exec(lines[i])[1].toLowerCase();
    const endRe = new RegExp('</' + tag + '[ \\t>]', 'i');
    while (k < lines.length) {
      if (endRe.test(lines[k])) { k++; break; }
      k++;
    }
  } else if (type === 2) {
    while (k < lines.length) { if (lines[k].includes('-->')) { k++; break; } k++; }
  } else if (type === 3) {
    while (k < lines.length) { if (lines[k].includes('?>')) { k++; break; } k++; }
  } else if (type === 4) {
    while (k < lines.length) { if (lines[k].includes('>')) { k++; break; } k++; }
  } else if (type === 5) {
    while (k < lines.length) { if (lines[k].includes(']]>')) { k++; break; } k++; }
  } else {
    while (k < lines.length && !isBlankStr(lines[k])) k++;
  }
  let html = lines.slice(start, k).join('\n');
  let trail = false;
  if (k >= lines.length) trail = isTop && inputEndsNL;
  else trail = type <= 5 ? lines[k] !== '' : !isBlankStr(lines[k]);
  if (trail) html += '\n';
  return { html, next: k };
}

function escLang(lang) {
  return lang.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ---- main block dispatcher ----
function parseBlocks(lines, refs, tight, isTop, lazy, inListItem) {
  let out = '', i = 0;
  const n = lines.length;
  let sawBlank = false, sawBlock = false, blankSep = false;
  while (i < n) {
    const line = lines[i];
    if (isBlankStr(line)) { sawBlank = true; i++; continue; }
    if (sawBlank && sawBlock) blankSep = true;
    sawBlank = false;
    const ind = indentCols(line);
    const nw = firstNW(line);
    const content = line.slice(nw);
    // fenced code
    const fence = matchFence(content, ind);
    if (fence) {
      const lang = unesc(fence.info.trim().split(/\s+/)[0] ?? '');
      const closeRe = new RegExp('^' + (fence.ch === '`' ? '`' : '~') + '{' + fence.len + ',}[ \\t]*$');
      const parts = [];
      let k = i + 1;
      while (k < n) {
        const l2 = lines[k];
        if (indentCols(l2) <= 3 && closeRe.test(l2.slice(firstNW(l2)))) { k++; break; }
        parts.push(stripCols(l2, fence.ind));
        k++;
      }
      let code = parts.join('\n');
      if (parts.length > 0 && parts[parts.length - 1] !== '') code += '\n';
      out += '<pre><code' + (lang ? ' class="language-' + escLang(lang) + '"' : '') + '>' + escAmpLtGt(code) + '</code></pre>\n';
      i = k;
      sawBlock = true;
      continue;
    }
    // indented code
    if (ind >= 4) {
      const parts = [];
      let k = i;
      while (k < n) {
        const l2 = lines[k];
        if (isBlankStr(l2)) {
          let m = k + 1;
          while (m < n && isBlankStr(lines[m])) m++;
          if (m < n && indentCols(lines[m]) >= 4) { parts.push(stripCols(l2, 4)); k++; continue; }
          break;
        }
        if (indentCols(l2) >= 4) { parts.push(stripCols(l2, 4)); k++; continue; }
        break;
      }
      while (parts.length && parts[parts.length - 1] === '') parts.pop();
      let code = parts.join('\n');
      if (parts.length > 0 && parts[parts.length - 1] !== '') code += '\n';
      out += '<pre><code>' + escAmpLtGt(code) + '</code></pre>\n';
      i = k;
      sawBlock = true;
      continue;
    }
    // ATX heading
    const atx = matchAtx(content, ind);
    if (atx) {
      out += '<h' + atx.level + '>' + parseInline(atx.text, refs) + '</h' + atx.level + '>\n';
      i++;
      sawBlock = true;
      continue;
    }
    // thematic break
    if (isThematicBreak(content, ind)) { out += '<hr>\n'; i++; sawBlock = true; continue; }
    // HTML block
    const hb = htmlBlockType(content, ind, false);
    if (hb !== 0) {
      const r = parseHtmlBlock(lines, i, hb, isTop);
      out += r.html;
      i = r.next;
      sawBlock = true;
      continue;
    }
    // blockquote
    if (ind <= 3 && content[0] === '>') {
      const r = parseBlockquote(lines, i, refs);
      out += r.html;
      i = r.next;
      sawBlock = true;
      continue;
    }
    // list
    const ls = matchList(content, ind);
    if (ls) {
      const r = parseList(lines, i, refs);
      out += r.html;
      i = r.next;
      sawBlock = true;
      continue;
    }
    // paragraph (link defs, setext, table)
    const r = parseParagraph(lines, i, refs, tight, lazy, inListItem);
    out += r.html;
    i = r.next;
    sawBlock = true;
  }
  return { html: out, blankSep };
}

// ---- entry point: stateless, nothing kept between calls ----
export function parse(markdown) {
  const refs = new Map();
  const text = String(markdown).replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const endsWithNL = text.endsWith('\n');
  inputEndsNL = endsWithNL;
  // A link reference definition needs ']:' in the text; without it there
  // can be no forward reference to resolve, so the collect pass is skipped.
  if (text.includes(']:')) {
    collectOnly = true;
    parseBlocks(lines, refs, false, true);
    collectOnly = false;
  }
  inRawA = false;
  const r = parseBlocks(lines, refs, false, true);
  return r.html;
}
