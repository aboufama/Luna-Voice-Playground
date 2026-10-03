import { MAX_PDF_PAGES, chaptersFrom, materialTitle, refusal } from './study-material.mjs';

// Reads a PDF entirely in the browser. Nothing is uploaded from here: the text
// stays in memory until the page decides what, if anything, Luna is told.

/** One page as text, plus each line with the size it is set in. */
async function readPage(page) {
  const content = await page.getTextContent(), lines = [];
  let text = '', size = 0;
  for (const item of content.items) {
    if (typeof item.str !== 'string') continue;
    text += item.str;
    if (item.str.trim()) size = Math.max(size, item.height || Math.hypot(item.transform?.[0] || 0, item.transform?.[1] || 0));
    if (item.hasEOL) { lines.push({ text, size }); text = ''; size = 0; }
    else text += ' ';
  }
  if (text.trim()) lines.push({ text, size });
  return { text: lines.map(line => line.text.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n'), lines };
}

/** The outline's entries as { title, page }. A single wrapping entry is opened to its children. */
async function readOutline(pdf) {
  let entries = await pdf.getOutline().catch(() => null) || [];
  if (entries.length === 1 && entries[0].items?.length > 1) entries = entries[0].items;
  const found = [];
  for (const entry of entries) {
    try {
      const dest = typeof entry.dest === 'string' ? await pdf.getDestination(entry.dest) : entry.dest;
      if (!Array.isArray(dest) || dest[0] == null) continue;
      const page = typeof dest[0] === 'number' ? dest[0] : await pdf.getPageIndex(dest[0]);
      found.push({ title: entry.title, page: page + 1 });
    } catch { /* an entry that points nowhere is simply not a chapter */ }
  }
  return found;
}

/** Turn a dropped file into { id, name, title, pageCount, chapters, unreadablePages }. Throws a sentence a person can act on. */
export async function readPdfMaterial(file) {
  const refused = refusal(file);
  if (refused) throw new Error(refused);
  const [pdfjs, { default: workerUrl }] = await Promise.all([import('pdfjs-dist'), import('pdfjs-dist/build/pdf.worker.min.mjs?url')]);
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  let loading;
  try {
    loading = pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()), isEvalSupported: false });
    const pdf = await loading.promise;
    if (pdf.numPages > MAX_PDF_PAGES) throw new Error(`That PDF has ${pdf.numPages} pages; the limit is ${MAX_PDF_PAGES}. Split it into smaller files.`);
    const pages = [];
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number);
      try { pages.push(await readPage(page)); } finally { page.cleanup(); }
    }
    const unreadablePages = pages.filter(page => !page.text).length;
    if (unreadablePages === pages.length) throw new Error('No readable text found in that PDF. Scanned pages need OCR, which is not available here.');
    const metadata = await pdf.getMetadata().then(data => data?.info?.Title || '').catch(() => '');
    return {
      id: crypto.randomUUID(), name: file.name, pageCount: pdf.numPages, unreadablePages,
      title: materialTitle({ metadata, pages, name: file.name }),
      chapters: chaptersFrom({ outline: await readOutline(pdf), pages }),
    };
  } catch (error) {
    if (error?.name === 'PasswordException') throw new Error('That PDF is password protected. Drop an unlocked copy.');
    if (/^(That|No readable)/.test(error?.message || '')) throw error;
    throw new Error('Could not read that PDF. Check that the file is valid and unlocked.');
  } finally { await loading?.destroy().catch(() => {}); }
}
