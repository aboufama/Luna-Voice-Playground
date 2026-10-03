import test from 'node:test';
import assert from 'node:assert/strict';
import { chaptersFrom, materialTitle, outlineBriefing, chapterBriefing, refusal, MAX_CHAPTERS, BRIEFING_CHARS, BRIEFING_PARTS } from '../src/study-material.mjs';
import { createMosaicField } from '../src/mosaic-field.mjs';
import { createMosaicLight } from '../src/mosaic-light.mjs';

const page = (text, lines) => ({ text, lines: lines || text.split('\n').map(line => ({ text: line, size: 11 })) });
const body = text => ({ text, size: 11 });

test('a PDF\'s own outline decides its chapters, and each one carries its pages\' text', () => {
  const pages = ['Cover', 'Light reactions happen in the thylakoid.', 'More on light.', 'The Calvin cycle fixes carbon.', 'Summary.'].map(text => page(text));
  const chapters = chaptersFrom({ pages, outline: [{ title: ' The Calvin   Cycle ', page: 4 }, { title: 'Light Reactions', page: 2 }, { title: 'Broken', page: 99 }, { title: '', page: 3 }] });
  assert.deepEqual(chapters.map(({ title, from, to, source }) => [title, from, to, source]), [['Light Reactions', 1, 3, 'outline'], ['The Calvin Cycle', 4, 5, 'outline']]);
  // Nothing is lost: whatever precedes the first chapter is read with it.
  assert.equal(chapters[0].text, 'Cover\n\nLight reactions happen in the thylakoid.\n\nMore on light.');
  assert.equal(chapters[1].text, 'The Calvin cycle fixes carbon.\n\nSummary.');
});

test('without an outline, lines set as headings mark the chapters; a lone title is not one', () => {
  const pages = [
    page('Cell Biology\nNotes for week one', [{ text: 'Cell Biology', size: 24 }, body('Notes for week one')]),
    page('Membranes\nA membrane is a bilayer.', [{ text: 'Membranes', size: 16 }, body('A membrane is a bilayer.')]),
    page('It is selectively permeable.'),
    page('Chapter 2 Organelles\nThe nucleus stores DNA.', [body('Chapter 2 Organelles'), body('The nucleus stores DNA.')]),
    page('12', [{ text: '12', size: 30 }]),
  ];
  const chapters = chaptersFrom({ pages });
  assert.deepEqual(chapters.map(({ title, from, to, source }) => [title, from, to, source]), [['Membranes', 1, 3, 'headings'], ['Chapter 2 Organelles', 4, 5, 'headings']]);
  assert.equal(materialTitle({ pages, name: 'bio_week-1.pdf' }), 'Cell Biology');
});

test('with nothing to go on, even runs of pages still give something to pick', () => {
  const pages = Array.from({ length: 20 }, (_, index) => page(`Plain text of page ${index + 1}.`));
  const chapters = chaptersFrom({ pages });
  assert.deepEqual(chapters.map(chapter => chapter.title), ['Pages 1–5', 'Pages 6–10', 'Pages 11–15', 'Pages 16–20']);
  assert.ok(chapters.every(chapter => chapter.source === 'pages'));
  assert.equal(chapters.reduce((sum, chapter) => sum + chapter.to - chapter.from + 1, 0), 20, 'every page belongs to exactly one chapter');
  assert.deepEqual(chaptersFrom({ pages: [page('Only one')] }).map(chapter => chapter.title), ['Page 1']);
  assert.deepEqual(chaptersFrom({ pages: [] }), []);
  // One stone per chapter has to fit round the rim.
  const long = chaptersFrom({ pages: Array.from({ length: 60 }, () => page('x')), outline: Array.from({ length: 40 }, (_, index) => ({ title: `Section ${index + 1}`, page: index + 1 })) });
  assert.equal(long.length, MAX_CHAPTERS);
  assert.equal(long.at(-1).to, 60, 'the last stone still reaches the end of the document');
});

test('the title is the document\'s own, else its biggest first line, else a tidied file name', () => {
  assert.equal(materialTitle({ metadata: '  Organic   Chemistry II ', name: 'x.pdf' }), 'Organic Chemistry II');
  for (const junk of ['Untitled', 'Microsoft Word - notes.docx', 'lecture.pdf', 'ab']) {
    assert.equal(materialTitle({ metadata: junk, pages: [page('small text only')], name: 'lecture_03-enzymes.pdf' }), 'lecture 03 enzymes', junk);
  }
  assert.equal(materialTitle({}), 'Untitled document');
});

test('Luna is first told only the chapter list, then the chosen chapter in bounded parts', () => {
  const material = { title: 'Cell Biology', pageCount: 5, chapters: [
    { title: 'Membranes', from: 1, to: 3, text: 'A membrane is a bilayer.' },
    { title: 'Organelles', from: 4, to: 4, text: '§'.repeat(BRIEFING_CHARS * BRIEFING_PARTS + 4321) },
    { title: 'Scans', from: 5, to: 5, text: '' },
  ] };
  const outline = outlineBriefing(material);
  assert.match(outline, /"Cell Biology", 5 pages/);
  assert.match(outline, /1\. Membranes \(pages 1–3\); 2\. Organelles \(page 4\); 3\. Scans \(page 5\)/);
  assert.equal(outline.includes('bilayer'), false, 'no chapter text before a chapter is chosen');

  const [only] = chapterBriefing(material, 0);
  assert.equal(chapterBriefing(material, 0).length, 1);
  assert.match(only, /chose chapter 1 of "Cell Biology": "Membranes" \(pages 1–3\)/);
  assert.ok(only.endsWith('A membrane is a bilayer.'));

  const parts = chapterBriefing(material, 1);
  assert.equal(parts.length, BRIEFING_PARTS);
  assert.ok(parts.every(part => part.length < BRIEFING_CHARS + 400), 'each message stays small enough to send');
  assert.match(parts[0], /only the first 15,000 of its 19,321 characters/, 'she is told plainly that it was cut short');
  assert.match(parts[2], /Part 3 of 3/);
  assert.equal(parts.join('').split('§').length - 1, BRIEFING_CHARS * BRIEFING_PARTS);

  assert.match(chapterBriefing(material, 2)[0], /no readable text/);
  assert.deepEqual(chapterBriefing(material, -1), []);
  assert.deepEqual(chapterBriefing(material, 9), []);
});

test('only PDFs of a workable size are taken', () => {
  assert.equal(refusal({ name: 'notes.PDF', type: '', size: 1000 }), '');
  assert.equal(refusal({ name: 'blob', type: 'application/pdf', size: 1000 }), '');
  assert.match(refusal({ name: 'notes.docx', type: 'application/vnd.openxmlformats', size: 1000 }), /not a PDF/);
  assert.match(refusal({ name: 'big.pdf', type: 'application/pdf', size: 21 * 1024 * 1024 }), /20 MB/);
});

test('each chapter stands out of the rim as one stone, clockwise from the top, and the chosen one stands further', () => {
  const tiles = createMosaicField().tiles, light = createMosaicLight(tiles);
  const clock = stone => ((Math.atan2(tiles[stone].y, tiles[stone].x) + Math.PI / 2) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
  let time = 0;
  const run = (frames, input) => { for (let frame = 0; frame < frames; frame++, time += 33) light.step({ state: 'idle', ...input, time }); };
  run(10, {});
  assert.equal(light.pegs.length, 0);
  assert.ok(light.lift.every(value => value === 0));

  // A document is there whether or not Luna is live: the pegs come out of plain stone.
  run(4, { chapters: 6 });
  assert.equal(new Set(light.pegs).size, 6, 'six different stones');
  assert.ok(light.pegs.every(stone => Math.hypot(tiles[stone].x, tiles[stone].y) > 138), 'all on the outermost course, with nothing beyond to hit');
  assert.ok(light.lift[light.pegs[0]] > 0 && light.lift[light.pegs[5]] === 0, 'they come out one after another, not all at once');
  run(40, { chapters: 6 });
  const places = light.pegs.map(clock);
  places.forEach((place, peg) => assert.ok(Math.abs(place - peg / 6 * Math.PI * 2) < .12, `peg ${peg} near its sixth of the rim`));
  assert.ok(light.pegs.every(stone => Math.abs(light.lift[stone] - 7) < .05), 'each at the same stop');
  assert.equal(light.lift.filter(value => value > 0).length, 6, 'and no other stone moves');
  assert.ok(light.pegs.every(stone => light.ink[stone] > .5 && light.cool[stone] === 0 && light.warm[stone] === 0), 'seen, but still stone while Luna is away');

  run(40, { state: 'listening', chapters: 6, chapter: 2, pointed: 4 });
  const [plain, chosen, pointed] = [0, 2, 4].map(peg => light.pegs[peg]);
  assert.ok(light.lift[chosen] > light.lift[pointed] + 2 && light.lift[pointed] > light.lift[plain] + 2);
  assert.ok(light.warm[chosen] > .95 && light.warm[plain] < .05, 'only the chosen chapter takes the warm stone');
  assert.ok(light.cool[plain] > .95);

  run(1, { state: 'listening', chapters: 6, chapter: 2, reduced: true });
  assert.ok(Math.abs(light.lift[chosen] - 13) < 1e-6 && Math.abs(light.lift[plain] - 7) < 1e-6, 'reduced motion shows them already at their stops');
  run(2, { state: 'listening' });
  assert.equal(light.pegs.length, 0);
  assert.ok(light.pegs.length === 0 && [chosen, plain].every(stone => light.lift[stone] < 2), 'putting the document away returns the stones to the rim');
});

test('a document held near the mosaic opens a hatch towards it without any two stones colliding', () => {
  const tiles = createMosaicField().tiles, light = createMosaicLight(tiles);
  const bearing = .6, radius = tile => Math.hypot(tile.x, tile.y), angle = tile => Math.atan2(tile.y, tile.x);
  const aside = tile => Math.atan2(Math.sin(angle(tile) - bearing), Math.cos(angle(tile) - bearing));
  light.step({ state: 'listening', time: 0 });
  assert.ok(light.turn.every(value => value === 0), 'closed when nothing is held');
  light.step({ state: 'listening', time: 33, hatch: { angle: bearing, open: 1 }, reduced: true });

  const rim = tiles.map((tile, index) => index).filter(index => radius(tiles[index]) > 132);
  const left = rim.filter(index => aside(tiles[index]) < -.02 && aside(tiles[index]) > -.4), right = rim.filter(index => aside(tiles[index]) > .02 && aside(tiles[index]) < .4);
  assert.ok(left.every(index => light.turn[index] < -.12) && right.every(index => light.turn[index] > .12), 'the two sides part');
  const opposite = rim.filter(index => Math.abs(aside(tiles[index])) > 3);
  assert.ok(opposite.every(index => Math.abs(light.turn[index]) < .012), 'hinged at the far side');
  assert.ok(tiles.every((tile, index) => radius(tile) > 56 || light.turn[index] === 0), 'the inner courses stay shut');
  assert.ok(left.concat(right).some(index => light.lift[index] > 4), 'and the lips step out towards the document');

  // Round any one course, neighbours keep their order and close up by only a few percent.
  for (const band of [[139, 146], [125, 132], [98, 104]]) {
    const course = tiles.map((tile, index) => ({ at: aside(tile), moved: aside(tile) + light.turn[index], r: radius(tile) })).filter(stone => stone.r > band[0] && stone.r < band[1] && stone.at > 0).sort((a, b) => a.at - b.at);
    for (let i = 1; i < course.length; i++) {
      const before = course[i].at - course[i - 1].at, after = course[i].moved - course[i - 1].moved;
      assert.ok(after > before * .92, `course at ${band[0]}: ${before.toFixed(4)} -> ${after.toFixed(4)}`);
    }
  }
  light.step({ state: 'listening', time: 66, hatch: { angle: bearing, open: 0 }, reduced: true });
  assert.ok(light.turn.every(value => value === 0), 'and it closes completely');
});
