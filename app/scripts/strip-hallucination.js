const fs = require('fs');
const path = require('path');

// One-off cleanup for transcripts generated before transcribe.py started filtering known
// Whisper hallucinations at generation time. Safe to rerun; add more phrases here and rerun
// if a new recurring hallucination shows up (keep it in sync with KNOWN_HALLUCINATIONS in
// transcribe.py so future transcriptions don't reintroduce it).
const TRANSCRIPTS_DIR = path.join(__dirname, '..', 'transcripts');
const BAD_PHRASE = 'ترجمة نانسي قنقر';

// Matches the phrase standalone or with a short prefix/suffix (e.g. "وترجمة نانسي قنقر"), but not
// a genuinely long sentence that happens to contain it.
function isHallucinationLine(text) {
  const t = text.trim();
  return t.includes(BAD_PHRASE) && t.length < BAD_PHRASE.length + 15;
}

function cleanTxt(filePath) {
  const lines = fs.readFileSync(filePath, 'utf-8').split('\n');
  const kept = lines.filter((l) => !isHallucinationLine(l));
  if (kept.length === lines.length) return false;
  fs.writeFileSync(filePath, kept.join('\n'));
  return true;
}

function cleanSrt(filePath) {
  const content = fs.readFileSync(filePath, 'utf-8').replace(/\r\n/g, '\n');
  const blocks = content.split(/\n\n+/).map((b) => b.trim()).filter(Boolean);
  const kept = blocks.filter((block) => {
    const lines = block.split('\n');
    const text = lines.slice(2).join(' ').trim();
    return !isHallucinationLine(text);
  });
  if (kept.length === blocks.length) return false;
  const renumbered = kept.map((block, i) => {
    const lines = block.split('\n');
    lines[0] = String(i + 1);
    return lines.join('\n');
  });
  fs.writeFileSync(filePath, renumbered.join('\n\n') + '\n');
  return true;
}

const files = fs.readdirSync(TRANSCRIPTS_DIR);
let txtCleaned = 0;
let srtCleaned = 0;
for (const f of files) {
  const full = path.join(TRANSCRIPTS_DIR, f);
  if (f.endsWith('.txt') && cleanTxt(full)) txtCleaned += 1;
  if (f.endsWith('.srt') && cleanSrt(full)) srtCleaned += 1;
}
console.log(`Cleaned ${txtCleaned} .txt and ${srtCleaned} .srt file(s).`);
