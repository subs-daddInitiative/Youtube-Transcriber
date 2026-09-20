const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'transcribe.py');
const TRANSCRIPTS_DIR = path.join(__dirname, '..', '..', 'transcripts');

/** filenameBase is a sanitized, unique-on-disk name derived from the video title (see naming.js). */
function transcribe(audioPath, filenameBase, onLog) {
  fs.mkdirSync(TRANSCRIPTS_DIR, { recursive: true });
  const outTxt = path.join(TRANSCRIPTS_DIR, `${filenameBase}.txt`);
  const outSrt = path.join(TRANSCRIPTS_DIR, `${filenameBase}.srt`);

  return new Promise((resolve, reject) => {
    const args = [
      SCRIPT,
      '--audio', audioPath,
      '--out-txt', outTxt,
      '--out-srt', outSrt,
      '--language', 'ar',
      '--model', 'large-v3-turbo',
      '--device', 'auto', // transcribe.py auto-detects a CUDA GPU and falls back to CPU if there isn't one
      '--compute-type', 'float16',
    ];
    const proc = spawn('python', args, { windowsHide: true });

    proc.stdout.on('data', (d) => onLog(d.toString()));
    proc.stderr.on('data', (d) => onLog(d.toString()));

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`transcribe.py exited with code ${code}`));
        return;
      }
      resolve({ txt: outTxt, srt: outSrt });
    });
  });
}

module.exports = { transcribe, TRANSCRIPTS_DIR };
