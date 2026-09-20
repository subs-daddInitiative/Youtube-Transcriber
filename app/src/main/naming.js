const fs = require('fs');
const path = require('path');

/** Turns a video title into a safe, emoji-free filename base (no extension). */
function sanitizeFilename(title, fallback) {
  if (!title) return fallback;
  let s = title.normalize('NFC');
  s = s.replace(/[\p{Extended_Pictographic}️‍]/gu, ''); // emoji
  s = s.replace(/[\\/:*?"<>|]/g, ''); // illegal on Windows
  s = s.replace(/[\x00-\x1f]/g, '');
  s = s.replace(/\s+/g, ' ').trim();
  s = s.replace(/[.\s]+$/, ''); // trailing dot/space breaks on Windows
  if (s.length > 150) s = s.slice(0, 150).trim();
  return s || fallback;
}

/** Appends " (2)", " (3)", ... until the name doesn't collide with an existing .txt/.srt in dir. */
function uniqueBaseName(dir, base) {
  fs.mkdirSync(dir, { recursive: true });
  const exists = (name) =>
    fs.existsSync(path.join(dir, `${name}.txt`)) || fs.existsSync(path.join(dir, `${name}.srt`));
  let candidate = base;
  let n = 2;
  while (exists(candidate)) {
    candidate = `${base} (${n})`;
    n += 1;
  }
  return candidate;
}

module.exports = { sanitizeFilename, uniqueBaseName };
