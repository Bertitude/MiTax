/**
 * PDF text/coordinate extraction backed by pdfjs-dist (maintained).
 *
 * Replaces the unmaintained `pdf-parse`, whose bundled pdfjs is affected by
 * CVE-2024-4367 (arbitrary JS execution from a crafted PDF) — a live risk since
 * this app parses user-supplied bank statements. pdfjs-dist is the same
 * underlying library pdf-parse wrapped, so extraction semantics are preserved:
 *
 *   - extractText closely reproduces pdf-parse's reflow (a newline is inserted
 *     when a text item's baseline Y — transform[5] — differs from the previous
 *     item's), so every text-based parser's line-oriented regexes still match.
 *     (Minor deviation: a leading item at baseline y=0 is treated as "no
 *     previous Y" here, where pdf-parse concatenated — practically negligible.)
 *   - extractPageItems reproduces the old `pagerender` coordinate output
 *     ({ str, x: transform[4], y: transform[5] } per non-empty item, per page)
 *     used by the coordinate-aware Scotiabank and JN parsers.
 */

'use strict';

let pdfjsPromise = null;
function loadPdfjs() {
  // pdfjs-dist v4 is ESM-only; this module is CommonJS, so import() dynamically
  // and cache the promise.
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

async function getDocument(buffer) {
  const pdfjs = await loadPdfjs();
  // pdfjs requires a plain Uint8Array — a Node Buffer (a Uint8Array subclass) is
  // rejected, so always copy into a fresh Uint8Array.
  const data = new Uint8Array(buffer);
  try {
    // isEvalSupported:false hardens against the crafted-PDF eval vector.
    return await pdfjs.getDocument({ data, useSystemFonts: true, isEvalSupported: false }).promise;
  } catch (err) {
    // Surface a clear message for encrypted statements instead of a raw
    // "No password given" PasswordException.
    if (err && (err.name === 'PasswordException' || /password/i.test(err.message || ''))) {
      throw new Error('This PDF is password-protected. Remove the password (open it and re-save/print to PDF without one) and try again.');
    }
    throw err;
  }
}

/**
 * Pure reflow: concatenate item.str values, inserting a newline whenever the
 * baseline Y changes. Matches pdf-parse's default render_page algorithm.
 */
function reflowItems(items) {
  let lastY;
  let text = '';
  for (const item of items) {
    if (item.str === undefined) continue;
    if (lastY === item.transform[5] || lastY === undefined) text += item.str;
    else text += '\n' + item.str;
    lastY = item.transform[5];
  }
  return text;
}

async function extractText(buffer) {
  const doc = await getDocument(buffer);
  try {
    let out = '';
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      // pdf-parse prefixed every page's text with "\n\n"; preserve that so any
      // cross-page/whitespace-sensitive regexes behave identically.
      out += '\n\n' + reflowItems(content.items);
    }
    return out;
  } finally {
    // Release the PDFDocumentProxy (page trees, fonts, the copied buffer) —
    // this runs in a long-lived Electron main process, so leaking it per import
    // accumulates. destroy() never rejects meaningfully; guard anyway.
    await doc.destroy().catch(() => {});
  }
}

async function extractPageItems(buffer) {
  const doc = await getDocument(buffer);
  try {
    const pages = [];
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const content = await page.getTextContent();
      const items = content.items
        .filter(i => i.str && i.str.trim())
        .map(i => ({ str: i.str.trim(), x: i.transform[4], y: i.transform[5] }));
      pages.push(items);
    }
    return pages;
  } finally {
    await doc.destroy().catch(() => {});
  }
}

module.exports = { extractText, extractPageItems, reflowItems };
