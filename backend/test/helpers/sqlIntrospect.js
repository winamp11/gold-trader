// Static SQL introspection for the raw-SQL write paths.
//
// The test suite is pure-function and never opens a connection, so a
// malformed statement — the 39-columns/38-placeholders INSERT in
// saveMechanicalVariantDecision — shipped and threw on every call in
// production without a single test noticing. These helpers parse the SQL
// out of the source text so that class of mistake is caught at `npm test`
// time, with no database required.
//
// This is deliberately a lightweight parser, not a full SQL grammar. It
// understands exactly the shapes this codebase writes: CREATE TABLE,
// ALTER TABLE ... ADD COLUMN, and parameterised INSERT ... VALUES. Anything
// it cannot parse confidently is reported as such rather than guessed at,
// so the tests can skip it explicitly instead of silently passing.

const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Non-column entries that can appear in a CREATE TABLE body.
const TABLE_CONSTRAINT_KEYWORDS = new Set([
  'PRIMARY', 'UNIQUE', 'FOREIGN', 'CHECK', 'CONSTRAINT', 'EXCLUDE', 'LIKE',
]);

// Every transform below is length-preserving: removed text is replaced with
// spaces rather than deleted, so an index into the processed text is still a
// valid index into the original source. Reported line numbers would
// otherwise drift by however much commentary was stripped above them.
const blank = s => s.replace(/[^\n]/g, ' ');

/** Strip `-- line comments`, leaving string literals intact. */
export function stripSqlComments(sql) {
  let out = '';
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (inString) {
      out += c;
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") { inString = true; out += c; continue; }
    if (c === '-' && sql[i + 1] === '-') {
      const start = i;
      while (i < sql.length && sql[i] !== '\n') i++;
      out += blank(sql.slice(start, i));
      if (i < sql.length) out += '\n';
      continue;
    }
    out += c;
  }
  return out;
}

/**
 * Blank out everything in a JS source file that is not the body of a
 * template literal, so only candidate SQL text survives.
 *
 * Without this, a JS `// ... INSERT into mechanical_variant_decisions ...`
 * comment reads to the parser as a real write path, and a `//` inside a URL
 * string can flip the scanner into a comment it never leaves.
 */
export function extractSqlRegions(source) {
  const out = new Array(source.length).fill(' ');
  const keep = i => { out[i] = source[i]; };
  // Stack entries: 'template' (inside a backtick body) or 'expr' (inside a
  // `${ ... }` interpolation, which is ordinary code again).
  const stack = [];
  const inTemplate = () => stack[stack.length - 1] === 'template';

  let i = 0;
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];

    if (c === '\n') { out[i] = '\n'; i++; continue; }

    if (inTemplate()) {
      if (c === '\\') { i += 2; continue; }
      // Backticks are preserved as statement boundaries; `${` is preserved
      // so interpolated VALUES stay detectable once the expression inside
      // it has been blanked.
      if (c === '`') { stack.pop(); keep(i); i++; continue; }
      if (c === '$' && next === '{') {
        stack.push('expr'); keep(i); keep(i + 1); i += 2; continue;
      }
      keep(i); i++; continue;
    }

    // Ordinary code (top level, or inside a `${}` interpolation).
    if (c === '/' && next === '/') {
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') out[i] = '\n';
        i++;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const quote = c;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') i++;
        else if (source[i] === '\n') break;
        i++;
      }
      i++;
      continue;
    }
    if (c === '`') { stack.push('template'); keep(i); i++; continue; }
    if (c === '}' && stack[stack.length - 1] === 'expr') { stack.pop(); i++; continue; }
    if (c === '{' && stack[stack.length - 1] === 'expr') {
      // A nested object/block inside the interpolation — push a matching
      // marker so its `}` does not close the interpolation early.
      stack.push('expr');
      i++;
      continue;
    }
    i++;
  }

  return out.join('');
}

/** SQL text of a source file, with JS scaffolding and SQL comments removed. */
export function sqlText(source) {
  return stripSqlComments(extractSqlRegions(source));
}

/**
 * Scan a balanced parenthesised group. `open` must be the index of the `(`.
 * Returns { body, end } where `end` is the index just past the closing `)`,
 * or null if the group never closes. String literals are skipped over so a
 * paren inside `'...'` does not affect depth.
 */
function scanBalanced(text, open) {
  if (text[open] !== '(') return null;
  let depth = 0;
  let inString = false;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") { inString = true; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return { body: text.slice(open + 1, i), end: i + 1 };
    }
  }
  return null;
}

/** Split on commas that sit at paren depth 0, ignoring string literals. */
function splitTopLevel(body) {
  const parts = [];
  let depth = 0;
  let inString = false;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (inString) {
      cur += c;
      if (c === "'") inString = false;
      continue;
    }
    if (c === "'") { inString = true; cur += c; continue; }
    if (c === '(') depth++;
    if (c === ')') depth--;
    if (c === ',' && depth === 0) { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map(p => p.trim()).filter(Boolean);
}

function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') line++;
  return line;
}

/** Every distinct `$n` in a fragment, as a sorted array of numbers. */
export function placeholderIndices(fragment) {
  const seen = new Set();
  for (const m of fragment.matchAll(/\$(\d+)/g)) seen.add(Number(m[1]));
  return [...seen].sort((a, b) => a - b);
}

/** Count `$n` occurrences (not distinct — positional slots). */
function countPlaceholders(fragment) {
  return [...fragment.matchAll(/\$\d+/g)].length;
}

/**
 * Parse the table schema out of source text: CREATE TABLE bodies plus any
 * ALTER TABLE ... ADD COLUMN migrations applied afterwards. Returns
 * { tableName: { name, columns: Map<name, {name, notNull, hasDefault, isSerial}> } }.
 */
export function extractSchema(source) {
  const text = sqlText(source);
  const tables = {};

  const createRe = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*\(/gi;
  for (const m of text.matchAll(createRe)) {
    const table = m[1];
    const group = scanBalanced(text, m.index + m[0].length - 1);
    if (!group) continue;
    const columns = new Map();
    for (const entry of splitTopLevel(group.body)) {
      const first = entry.split(/\s+/)[0];
      if (TABLE_CONSTRAINT_KEYWORDS.has(first.toUpperCase())) continue;
      if (!IDENT.test(first)) continue;
      columns.set(first, {
        name: first,
        notNull: /\bNOT\s+NULL\b/i.test(entry),
        hasDefault: /\bDEFAULT\b/i.test(entry),
        isSerial: /\b(?:BIG)?SERIAL\b/i.test(entry),
      });
    }
    // A table created more than once in source (defensive re-runs) merges.
    tables[table] = tables[table] || { name: table, columns: new Map() };
    for (const [k, v] of columns) tables[table].columns.set(k, v);
  }

  const alterRe =
    /ALTER\s+TABLE\s+([A-Za-z_][A-Za-z0-9_]*)\s+ADD\s+COLUMN\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)([^`;]*)/gi;
  for (const m of text.matchAll(alterRe)) {
    const [, table, column, rest] = m;
    if (!tables[table]) tables[table] = { name: table, columns: new Map() };
    if (tables[table].columns.has(column)) continue;
    tables[table].columns.set(column, {
      name: column,
      notNull: /\bNOT\s+NULL\b/i.test(rest),
      hasDefault: /\bDEFAULT\b/i.test(rest),
      isSerial: /\b(?:BIG)?SERIAL\b/i.test(rest),
    });
  }

  return tables;
}

/**
 * Parse every `INSERT INTO <table> (cols) VALUES ...` in source text.
 *
 * Each result: {
 *   file, line, table, columns[],
 *   dynamicValues,        // VALUES built by interpolation — row shape unknowable statically
 *   valuesFromSelect,     // INSERT ... SELECT — no VALUES tuple to compare
 *   rowPlaceholderCount,  // positional slots in the first VALUES tuple
 *   rowValueCount,        // value expressions in the first VALUES tuple
 *   rawStatement,         // the statement text, ready to hand to PREPARE
 *   allPlaceholders,      // distinct $n across the whole statement
 * }
 */
export function extractInserts(source, file = '<source>') {
  const text = sqlText(source);
  const results = [];

  const insertRe = /INSERT\s+INTO\s+([A-Za-z_][A-Za-z0-9_]*)\s*/gi;
  for (const m of text.matchAll(insertRe)) {
    const table = m[1];
    const line = lineOf(source, m.index);
    let cursor = m.index + m[0].length;

    // Column list is optional in SQL, but every INSERT in this codebase has
    // one. If it is absent we cannot check arity, so record it and move on.
    if (text[cursor] !== '(') {
      results.push({
        file, line, table, columns: null, noColumnList: true, rawStatement: null,
        dynamicValues: false, valuesFromSelect: false,
        rowPlaceholderCount: 0, rowValueCount: 0, allPlaceholders: [],
      });
      continue;
    }
    const colGroup = scanBalanced(text, cursor);
    if (!colGroup) continue;
    cursor = colGroup.end;

    const columns = splitTopLevel(colGroup.body);
    const malformed = columns.filter(c => !IDENT.test(c));

    // The statement runs to the end of its template literal (or `;`).
    let end = text.length;
    for (let i = cursor; i < text.length; i++) {
      if (text[i] === '`' || text[i] === ';') { end = i; break; }
    }
    const tail = text.slice(cursor, end);

    const valuesMatch = /\bVALUES\b/i.exec(tail);
    if (!valuesMatch) {
      results.push({
        file, line, table, columns, malformed, rawStatement: text.slice(m.index, end),
        dynamicValues: false, valuesFromSelect: /\bSELECT\b/i.test(tail),
        rowPlaceholderCount: 0, rowValueCount: 0, allPlaceholders: placeholderIndices(tail),
      });
      continue;
    }

    const afterValues = tail.slice(valuesMatch.index + valuesMatch[0].length);
    const parenAt = afterValues.indexOf('(');
    // `VALUES ${...}` — row tuples are assembled at runtime.
    const dynamicValues =
      afterValues.slice(0, parenAt === -1 ? afterValues.length : parenAt).includes('${');

    // Arity is columns vs. *value expressions*, not columns vs. placeholders:
    // a tuple may legitimately hold a literal, as upsertDailyPnl's
    // `VALUES ($1, $2, $3, 1, $4, $5)` does for its trades_count of 1.
    let rowPlaceholderCount = 0;
    let rowValueCount = 0;
    if (!dynamicValues && parenAt !== -1) {
      const rowGroup = scanBalanced(afterValues, parenAt);
      if (rowGroup) {
        rowPlaceholderCount = countPlaceholders(rowGroup.body);
        rowValueCount = splitTopLevel(rowGroup.body).length;
      }
    }

    results.push({
      file, line, table, columns, malformed,
      // The statement as Postgres would see it: JS scaffolding and SQL
      // comments blanked out, so it can be handed straight to PREPARE.
      rawStatement: text.slice(m.index, end),
      dynamicValues,
      valuesFromSelect: false,
      rowPlaceholderCount,
      rowValueCount,
      allPlaceholders: placeholderIndices(tail),
    });
  }

  return results;
}

/**
 * Parse every parameterised statement (any verb) so the `$1..$N` sequence
 * can be checked for gaps. pg silently accepts a query that never
 * references `$3` while still being passed a 4-element params array, which
 * is how an off-by-one in a long UPDATE goes unnoticed.
 */
export function extractParameterisedStatements(source, file = '<source>') {
  const text = sqlText(source);
  const out = [];
  // `ON CONFLICT ... DO UPDATE SET x = $2` is a clause of the enclosing
  // INSERT, not a statement of its own -- reading it as one reports every
  // upsert as starting its numbering at $2.
  const stmtRe = /\b(?:(DO)\s+)?(INSERT|UPDATE|DELETE|SELECT)\b/gi;
  for (const m of text.matchAll(stmtRe)) {
    if (m[1]) continue;
    let end = text.length;
    for (let i = m.index; i < text.length; i++) {
      if (text[i] === '`' || text[i] === ';') { end = i; break; }
    }
    const body = text.slice(m.index, end);
    const placeholders = placeholderIndices(body);
    if (placeholders.length === 0) continue;
    out.push({
      file,
      line: lineOf(source, m.index),
      verb: m[2].toUpperCase(),
      placeholders,
      dynamic: body.includes('${'),
    });
  }
  return out;
}

/**
 * DDL statements in source order: every CREATE TABLE and ALTER TABLE with
 * the table it targets.
 *
 * initialize() runs these top to bottom against whatever the database
 * currently is. On an established deployment every table already exists, so
 * an ALTER sitting above its own CREATE TABLE still succeeds and the
 * mistake stays invisible — until the first boot against an empty database,
 * where it throws and aborts the whole schema bootstrap.
 */
export function extractDdlSequence(source) {
  const text = sqlText(source);
  const out = [];
  const re =
    /\b(CREATE\s+TABLE|ALTER\s+TABLE)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (const m of text.matchAll(re)) {
    out.push({
      kind: /CREATE/i.test(m[1]) ? 'create' : 'alter',
      table: m[2],
      line: lineOf(source, m.index),
    });
  }
  return out;
}
