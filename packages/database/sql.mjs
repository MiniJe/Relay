// SQL migration utilities shared by the PostgreSQL migration runner.
//
// Relay migrations are plain forward-only `.sql` files applied in filename
// order. Splitting them into statements has to survive the constructs real
// migrations use - line and block comments, quoted identifiers, string literals
// with escaped quotes, and dollar-quoted PL/pgSQL bodies - otherwise a
// semicolon inside a string would truncate a migration mid-statement.

const MIGRATION_FILE_PATTERN = /^\d{3}_[a-z0-9_]+\.sql$/;

/**
 * Migration files are ordered by their zero-padded numeric prefix, then by the
 * remainder of the filename. Ordering is derived from the filename alone so it
 * is stable across filesystems and never depends on readdir order.
 */
export function sortMigrationNames(names) {
  return [...names].sort((a, b) => {
    const prefixA = Number(a.slice(0, 3));
    const prefixB = Number(b.slice(0, 3));
    if (prefixA !== prefixB) return prefixA - prefixB;
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

export function isMigrationFileName(name) {
  return MIGRATION_FILE_PATTERN.test(name);
}

/**
 * Split a migration script into individual statements. The trailing semicolon
 * is removed; an explicit `BEGIN;`/`COMMIT;` pair is preserved as statements so
 * callers may choose to run the file inside its own transaction instead.
 */
export function splitSqlStatements(source) {
  const text = String(source);
  const statements = [];
  let current = '';
  let index = 0;

  while (index < text.length) {
    const char = text[index];
    const next = text[index + 1];

    // Line comment
    if (char === '-' && next === '-') {
      const end = text.indexOf('\n', index);
      const stop = end === -1 ? text.length : end;
      current += text.slice(index, stop);
      index = stop;
      continue;
    }

    // Block comment (nesting is not used by Relay migrations)
    if (char === '/' && next === '*') {
      const end = text.indexOf('*/', index + 2);
      const stop = end === -1 ? text.length : end + 2;
      current += text.slice(index, stop);
      index = stop;
      continue;
    }

    // String literal, with '' as the escape for an embedded quote
    if (char === "'") {
      let stop = index + 1;
      while (stop < text.length) {
        if (text[stop] === "'") {
          if (text[stop + 1] === "'") { stop += 2; continue; }
          stop += 1;
          break;
        }
        stop += 1;
      }
      current += text.slice(index, stop);
      index = stop;
      continue;
    }

    // Quoted identifier
    if (char === '"') {
      let stop = index + 1;
      while (stop < text.length) {
        if (text[stop] === '"') {
          if (text[stop + 1] === '"') { stop += 2; continue; }
          stop += 1;
          break;
        }
        stop += 1;
      }
      current += text.slice(index, stop);
      index = stop;
      continue;
    }

    // Dollar-quoted body: $tag$ ... $tag$
    if (char === '$') {
      const tag = /^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/.exec(text.slice(index));
      if (tag) {
        const closing = text.indexOf(tag[0], index + tag[0].length);
        const stop = closing === -1 ? text.length : closing + tag[0].length;
        current += text.slice(index, stop);
        index = stop;
        continue;
      }
    }

    if (char === ';') {
      statements.push(current);
      current = '';
      index += 1;
      continue;
    }

    current += char;
    index += 1;
  }
  statements.push(current);

  return statements
    .map((statement) => trimCommentLines(statement).trim())
    .filter((statement) => statement.length > 0);
}

/**
 * Remove comment-only lines from the start and end of a statement so that a
 * wrapper such as `-- heading\nBEGIN` is recognised as the bare `BEGIN`
 * statement it is. Interior comments are preserved untouched.
 */
function trimCommentLines(statement) {
  const lines = String(statement).split('\n');
  let start = 0;
  let end = lines.length;
  while (start < end && isCommentLine(lines[start])) start += 1;
  while (end > start && isCommentLine(lines[end - 1])) end -= 1;
  return lines.slice(start, end).join('\n');
}

function isCommentLine(line) {
  const trimmed = line.trim();
  return trimmed === '' || trimmed.startsWith('--');
}

/**
 * Strip a wrapping BEGIN;/COMMIT; pair so the caller can execute the body
 * inside a transaction it controls (and record the migration atomically).
 */
export function stripTransactionWrapper(statements) {
  const out = [...statements];
  if (out.length && /^BEGIN$/i.test(out[0])) out.shift();
  if (out.length && /^COMMIT$/i.test(out.at(-1))) out.pop();
  return out;
}
