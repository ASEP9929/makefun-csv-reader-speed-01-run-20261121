// Fast drop-in replacement for csv-reader 1.0.0 (make.fun's own CSV reader).
// run(input) returns exactly {columns, rows, errors} for {text, header}, per the
// written broken-row policy in the kit's RULES.txt / vendor/csv-reader/index.js:
//
//   - U+FEFF at the very start is dropped;
//   - a record ends at LF or CRLF, a line with no characters is no record;
//   - outside quotes a CR not followed by LF is dropped (stray_cr);
//   - a field opening with a quote runs to the next quote that is not doubled,
//     "" inside it is one quote, CRLF / lone CR inside it read as LF; what
//     follows its closing quote up to the next comma or line break is appended
//     as it stands (quote_junk, when the field ends); a quote that never closes
//     is a literal character and the text after it is read again as unquoted
//     (unterminated_quote); a quote inside an unquoted field is literal;
//   - fields stay strings, never trimmed or converted;
//   - columns is the first record when header is true, else null; rows holds the
//     records after it, each padded with "" (short_row, with fields: its count)
//     or cut (long_row, with extra: the cut fields) to the first record's width;
//   - each error is {code, line, row}, line the 1-based line its record starts
//     on, row its record's index in rows (null for the header), in the order met.
//
// Speed strategy, v4:
//   - A record holding no quote is split natively (slice + split(',')) once a
//     bounded CR check clears it; the CR check runs on the slice itself, so no
//     scan ever runs past the record's end.
//   - An unquoted field is usually found by two bounded indexOf jumps (next
//     comma, next LF) plus a tiny CR check on its own slice; only a field that
//     actually holds a lone CR falls back to a delimiter scan. A clean field
//     returns its slice as-is, never a copy of a copy.
//   - A quoted field is found with indexOf jumps (closing-quote search), its
//     line breaks counted in bulk, its "" collapsed and CRs normalised only
//     when the span actually holds them.
//   - The field reader is inlined in the record loop and the unquoted reader
//     reports through shared locals, so no per-field call frame or result
//     array is allocated.

const COMMA = 0;
const BREAK = 1;
const END = 2;

/** The next field delimiter (comma, CR or LF), for the lone-CR fallback only. */
const DELIM = /[,\r\n]/g;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  const len = text.length;
  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  let line = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). These are read by the field reader below.
  let recordLine = 1;
  let recordRow = null;

  // The unquoted reader's result, through shared locals (no array per field).
  let uqVal = '';
  let uqEnd = END;
  let uqAdd = 0;

  // Reads unquoted characters onto `value` up to the next comma or line break.
  // A CR not followed by LF is dropped (stray_cr). Reports through uqVal,
  // uqEnd, uqAdd; uqAdd counts the characters kept (for the quote_junk check).
  function readUnquoted(value) {
    let added = 0;
    let acc = value;
    while (pos < len) {
      // Optimistic cut: the field ends at the nearer of the next comma and
      // the next LF (or the end of the text).
      const ci = text.indexOf(',', pos);
      const ni = text.indexOf('\n', pos);
      let j;
      let kind;
      if (ci !== -1 && (ni === -1 || ci < ni)) { j = ci; kind = COMMA; }
      else if (ni !== -1) { j = ni; kind = BREAK; }
      else { j = len; kind = END; }
      let end = j;
      if (kind === BREAK && end > pos && text.charCodeAt(end - 1) === 13) end -= 1;
      const seg = text.slice(pos, end);
      if (seg.indexOf('\r') === -1) {
        // Clean: no lone CR in the field. A fresh field keeps the slice
        // as-is instead of a copy of a copy.
        if (kind === COMMA) pos = j + 1;
        else if (kind === BREAK) { pos = j + 1; line += 1; }
        else pos = len;
        uqVal = acc === '' ? seg : acc + seg;
        uqEnd = kind;
        uqAdd = added + seg.length;
        return;
      }
      // A lone CR sits in the field: walk it delimiter by delimiter.
      while (pos < len) {
        DELIM.lastIndex = pos;
        const m = DELIM.exec(text);
        if (m === null) {
          acc += text.slice(pos);
          added += len - pos;
          pos = len;
          uqVal = acc;
          uqEnd = END;
          uqAdd = added;
          return;
        }
        const k = m.index;
        if (k > pos) {
          acc += text.slice(pos, k);
          added += k - pos;
          pos = k;
        }
        const c = m[0];
        if (c === ',') {
          pos += 1;
          uqVal = acc;
          uqEnd = COMMA;
          uqAdd = added;
          return;
        }
        if (c === '\n') {
          pos += 1;
          line += 1;
          uqVal = acc;
          uqEnd = BREAK;
          uqAdd = added;
          return;
        }
        // A CR: CRLF ends the field; a lone CR is dropped (stray_cr).
        if (text.charCodeAt(pos + 1) === 10) {
          pos += 2;
          line += 1;
          uqVal = acc;
          uqEnd = BREAK;
          uqAdd = added;
          return;
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        pos += 1;
      }
      uqVal = acc;
      uqEnd = END;
      uqAdd = added;
      return;
    }
    uqVal = acc;
    uqEnd = END;
    uqAdd = added;
  }

  while (pos < len) {
    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Fast path: a record holding no quote, and no CR in its span, is split
    // natively. The quote search stops at the first quote (quotes are
    // frequent, so it rarely runs far); the CR check runs on the slice
    // itself, so no scan ever runs past the record's end.
    const ni = text.indexOf('\n', pos);
    let spanEnd = ni === -1 ? len : ni;
    if (ni !== -1 && spanEnd > pos && text.charCodeAt(spanEnd - 1) === 13) spanEnd -= 1;
    if (spanEnd === pos) {
      // A line with no characters is no record.
      if (ni === -1) break;
      pos = ni + 1;
      line += 1;
      continue;
    }
    const qi = text.indexOf('"', pos);
    let fields;
    let quoted = false;
    if (qi === -1 || qi >= spanEnd) {
      const span = text.slice(pos, spanEnd);
      if (span.indexOf('\r') === -1) {
        fields = span.split(',');
        if (ni === -1) pos = len;
        else { pos = ni + 1; line += 1; }
      }
    }
    if (fields === undefined) {
      fields = [];
      let ended;
      do {
        // --- one field, inlined (readField) ---
        let fval;
        if (text.charCodeAt(pos) === 34) {
          quoted = true;
          // Quoted field: find the closing quote (a quote that is not doubled).
          const open = pos;
          const openLine = line;
          let q = text.indexOf('"', pos + 1);
          while (q !== -1 && text.charCodeAt(q + 1) === 34) q = text.indexOf('"', q + 2);
          if (q === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            pos = open + 1;
            line = openLine;
            readUnquoted('"');
            fval = uqVal;
            ended = uqEnd;
          } else {
            // A '"' strictly inside the span is a doubled quote (q itself is
            // the first '"' at or after open + 1 that is not doubled).
            const hasDQ = text.indexOf('"', open + 1) < q;
            const cr1 = text.indexOf('\r', open + 1);
            const nl1 = text.indexOf('\n', open + 1);
            const hasCR = cr1 !== -1 && cr1 < q;
            const hasNL = nl1 !== -1 && nl1 < q;
            let value = text.slice(open + 1, q);
            if (hasDQ) value = value.replaceAll('""', '"');
            if (hasCR) value = value.replace(/\r\n?/g, '\n');
            if (hasCR || hasNL) {
              // Count the line breaks inside the quotes: each LF and each CR
              // counts once (a CRLF pair counts once).
              let inc = 0;
              let p = open + 1;
              while (p < q) {
                const a = text.indexOf('\n', p);
                const b = text.indexOf('\r', p);
                if ((a === -1 || a >= q) && (b === -1 || b >= q)) break;
                if (b !== -1 && b < q && (a === -1 || a >= q || b < a)) {
                  inc += 1;
                  p = text.charCodeAt(b + 1) === 10 ? b + 2 : b + 1;
                } else {
                  inc += 1;
                  p = a + 1;
                }
              }
              line += inc;
            }
            pos = q + 1;
            if (pos >= len) {
              fval = value;
              ended = END;
            } else {
              const c = text.charCodeAt(pos);
              if (c === 44) {
                pos += 1;
                fval = value;
                ended = COMMA;
              } else if (c === 10) {
                pos += 1;
                line += 1;
                fval = value;
                ended = BREAK;
              } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
                pos += 2;
                line += 1;
                fval = value;
                ended = BREAK;
              } else {
                // What follows the closing quote is appended as it stands, up
                // to the next comma or line break.
                readUnquoted(value);
                if (uqAdd > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
                fval = uqVal;
                ended = uqEnd;
              }
            }
          }
        } else {
          quoted = false;
          // Unquoted field, inlined: it ends at the nearer of the next comma
          // and the next LF (or the end of the text). A field holding no lone
          // CR keeps its slice as-is; one that does falls back to the
          // delimiter scan in readUnquoted.
          const ci = text.indexOf(',', pos);
          const ni2 = text.indexOf('\n', pos);
          let j;
          let kind;
          if (ci !== -1 && (ni2 === -1 || ci < ni2)) { j = ci; kind = COMMA; }
          else if (ni2 !== -1) { j = ni2; kind = BREAK; }
          else { j = len; kind = END; }
          let end = j;
          if (kind === BREAK && end > pos && text.charCodeAt(end - 1) === 13) end -= 1;
          const seg = text.slice(pos, end);
          if (seg.indexOf('\r') === -1) {
            if (kind === COMMA) pos = j + 1;
            else if (kind === BREAK) { pos = j + 1; line += 1; }
            else pos = len;
            fval = seg;
            ended = kind;
          } else {
            readUnquoted('');
            fval = uqVal;
            ended = uqEnd;
          }
        }
        fields.push(fval);
      } while (ended === COMMA);
      // A line that held only stray CRs is left with no characters: no record
      // (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !quoted) continue;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  return { columns: header ? (columns ?? []) : null, rows, errors };
}
