// A dropped document becomes a title and a short list of chapters. Everything
// here is plain data in, plain data out; reading the PDF itself is in
// study-material-pdf.js, which only runs in a browser.

export const MAX_PDF_BYTES = 20 * 1024 * 1024;
export const MAX_PDF_PAGES = 250;
// One stone per chapter has to stay readable around the rim.
export const MAX_CHAPTERS = 24;
// Luna is told about a chapter in a few messages of this size, not the whole book.
export const BRIEFING_CHARS = 5000;
export const BRIEFING_PARTS = 3;

const HEADING_WORD = /^(chapter|part|unit|lecture|module|section)\s+(\d+|[ivxlc]+|one|two|three|four|five|six|seven|eight|nine|ten)\b/i;
const tidy = text => String(text ?? '').replace(/\u0000/g, '').replace(/\s+/g, ' ').trim();
const short = (text, limit) => text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`;

/** The size most of the text is set in, weighted by how much text uses it. */
function bodySize(pages) {
  const weight = new Map();
  for (const page of pages) for (const line of page.lines || []) {
    const size = Math.round((line.size || 0) * 2) / 2;
    if (size > 0) weight.set(size, (weight.get(size) || 0) + tidy(line.text).length);
  }
  let best = 0, most = -1;
  for (const [size, amount] of weight) if (amount > most) { best = size; most = amount; }
  return best;
}

/** Lines that are set like headings, one per page at most, largest type first. */
function headings(pages) {
  const body = bodySize(pages), found = [];
  pages.forEach((page, index) => {
    let best = null;
    for (const line of page.lines || []) {
      const text = tidy(line.text);
      if (text.length < 3 || text.length > 90 || !/\p{L}/u.test(text)) continue;
      const named = HEADING_WORD.test(text), large = body > 0 && line.size >= body * 1.18;
      if (!named && !large) continue;
      const rank = (named ? 1000 : 0) + (line.size || 0);
      if (!best || rank > best.rank) best = { title: text, page: index + 1, size: line.size || 0, named, rank };
    }
    if (best) found.push(best);
  });
  return found;
}

/**
 * Chapters for a document, by the best evidence it offers:
 *   1. its own outline (bookmarks), when it has at least two entries;
 *   2. lines set as headings, when they mark at least two pages;
 *   3. otherwise even runs of pages, so there is always something to pick.
 * `outline` is [{ title, page }] with 1-based pages; `pages` is
 * [{ text, lines: [{ text, size }] }] in reading order.
 */
export function chaptersFrom({ outline = [], pages = [] } = {}) {
  const count = pages.length;
  if (!count) return [];
  const within = entry => Number.isInteger(entry.page) && entry.page >= 1 && entry.page <= count && tidy(entry.title);
  let starts = outline.filter(within).map(entry => ({ title: tidy(entry.title), page: entry.page }));
  let source = 'outline';
  if (starts.length < 2) {
    const marked = headings(pages);
    // A lone line in the largest type on the first page is the document's title, not a chapter.
    const largest = Math.max(0, ...marked.map(mark => mark.size));
    const chapters = marked.filter(mark => !(mark.page === 1 && !mark.named && mark.size === largest && marked.filter(other => other.size === largest).length === 1));
    starts = chapters.map(({ title, page }) => ({ title, page }));
    source = 'headings';
  }
  if (starts.length < 2) {
    const parts = Math.min(8, Math.max(1, Math.ceil(count / 6))), run = Math.ceil(count / parts);
    starts = [];
    for (let page = 1; page <= count; page += run) {
      const last = Math.min(count, page + run - 1);
      starts.push({ title: last === page ? `Page ${page}` : `Pages ${page}–${last}`, page });
    }
    source = 'pages';
  }
  starts.sort((a, b) => a.page - b.page);
  // Two entries on one page are one place to start reading; keep the first.
  starts = starts.filter((entry, index) => index === 0 || entry.page !== starts[index - 1].page).slice(0, MAX_CHAPTERS);
  // Whatever comes before the first chapter belongs with it.
  if (starts.length) starts[0] = { ...starts[0], page: 1 };
  return starts.map((entry, index) => {
    const to = index + 1 < starts.length ? starts[index + 1].page - 1 : count;
    const text = pages.slice(entry.page - 1, to).map(page => String(page.text || '').trim()).filter(Boolean).join('\n\n');
    return { title: short(entry.title, 80), from: entry.page, to, text, source };
  });
}

/** What to call the document: its own title, else its largest first line, else the file name. */
export function materialTitle({ metadata = '', pages = [], name = '' } = {}) {
  const stated = tidy(metadata);
  if (stated.length >= 3 && !/^(untitled|microsoft word|document\d*)\b/i.test(stated) && !/\.(pdf|docx?|tex)$/i.test(stated)) return short(stated, 90);
  const first = (pages[0]?.lines || []).map(line => ({ text: tidy(line.text), size: line.size || 0 })).filter(line => line.text.length >= 3 && /\p{L}/u.test(line.text));
  const body = bodySize(pages), top = first.reduce((best, line) => line.size > best.size ? line : best, { size: 0, text: '' });
  if (top.text && top.size >= body * 1.18) return short(top.text, 90);
  return short(tidy(String(name).replace(/\.[a-z0-9]+$/i, '').replace(/[_-]+/g, ' ')) || 'Untitled document', 90);
}

const pagesOf = chapter => chapter.from === chapter.to ? `page ${chapter.from}` : `pages ${chapter.from}–${chapter.to}`;

/** What Luna is told when a document arrives: its name and chapter titles, nothing more. */
export function outlineBriefing(material) {
  const list = material.chapters.map((chapter, index) => `${index + 1}. ${chapter.title} (${pagesOf(chapter)})`).join('; ');
  return `The person has just handed you a document to study together: "${material.title}", ${material.pageCount} ${material.pageCount === 1 ? 'page' : 'pages'}. `
    + `Its chapters are: ${list}. `
    + 'So far you have only this list, not the text. They choose a chapter by pressing its stone on the mosaic; when they do you will be given that chapter. '
    + 'If they ask about details before then, say you need them to pick a chapter first.';
}

/**
 * What Luna is told when a chapter is chosen: its text, in a few messages of
 * bounded size, and an honest note when it had to be cut short.
 */
export function chapterBriefing(material, index) {
  const chapter = material.chapters[index];
  if (!chapter) return [];
  const text = chapter.text.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  const head = `The person chose chapter ${index + 1} of "${material.title}": "${chapter.title}" (${pagesOf(chapter)}).`;
  if (!text) return [`${head} This chapter has no readable text (it may be scanned images), so you cannot see it. Say so if they ask about it.`];
  const limit = BRIEFING_CHARS * BRIEFING_PARTS, kept = text.slice(0, limit), cut = text.length > limit;
  const parts = [];
  for (let at = 0; at < kept.length; at += BRIEFING_CHARS) parts.push(kept.slice(at, at + BRIEFING_CHARS));
  return parts.map((part, number) => {
    const place = parts.length > 1 ? ` Part ${number + 1} of ${parts.length}.` : '';
    const first = number === 0 ? `${head} Use this text to help them study it.${cut ? ` It is long, so you are given only the first ${limit.toLocaleString('en')} of its ${text.length.toLocaleString('en')} characters; say so if they ask about something later in it.` : ''}` : `More of chapter ${index + 1}, "${chapter.title}".`;
    return `${first}${place}\n\n${part}`;
  });
}

/** Refuse what cannot be read before any work is done. Returns a message, or '' when the file is fine. */
export function refusal(file) {
  const name = String(file?.name || '');
  if (!/\.pdf$/i.test(name) && file?.type !== 'application/pdf') return 'That is not a PDF. Drop a PDF to study it with Luna.';
  if (file.size > MAX_PDF_BYTES) return 'That PDF is larger than 20 MB. Split it into smaller files.';
  return '';
}
