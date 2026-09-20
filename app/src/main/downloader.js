const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const AUDIO_DIR = path.join(__dirname, '..', '..', 'audio');

// Patterns yt-dlp/YouTube emit when the IP is being throttled or bot-checked, as opposed to
// an ordinary per-video failure (deleted video, geo-block, age-gated, etc). Only these should
// back off and retry the SAME video; everything else is a permanent per-video failure that
// must move the queue on, or a misclassified error here would retry forever.
const RATE_LIMIT_PATTERNS = [
  /HTTP Error 429/i,
  /Too Many Requests/i,
  /confirm (you.?re|you are) not a bot/i,
];

// "Sign in to confirm your age" etc. LOOK similar but are permanent, per-video, and will
// never clear by waiting — explicitly exclude them even if a rate-limit pattern also matched.
const PERMANENT_ERROR_PATTERNS = [/sign in to confirm your age/i, /age.restrict/i];

function looksRateLimited(text) {
  if (PERMANENT_ERROR_PATTERNS.some((re) => re.test(text))) return false;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

/** Downloads the smallest usable speech-only audio track for a video via yt-dlp. Kept permanently (not cleaned up) for reuse in other plans. */
function downloadAudio(url, videoId, onLog) {
  fs.mkdirSync(AUDIO_DIR, { recursive: true });
  const outTemplate = path.join(AUDIO_DIR, `${videoId}.%(ext)s`);

  return new Promise((resolve, reject) => {
    const args = [
      '-m', 'yt_dlp',
      '-f', 'worstaudio/worst',
      '-x',
      '--audio-format', 'opus',
      '--postprocessor-args', 'ffmpeg:-ac 1 -ar 16000 -b:a 32k',
      '--no-playlist',
      '--no-progress',
      '-o', outTemplate,
      url,
    ];
    // invoked as `python -m yt_dlp` rather than the `yt-dlp` shim so it works regardless of PATH setup
    const proc = spawn('python', args, { windowsHide: true });

    let combinedOutput = '';
    const capture = (d) => {
      const text = d.toString();
      combinedOutput += text;
      onLog(text);
    };
    proc.stdout.on('data', capture);
    proc.stderr.on('data', capture);

    proc.on('error', (err) => reject(err));
    proc.on('close', (code) => {
      if (code !== 0) {
        const err = new Error(`yt-dlp exited with code ${code}`);
        err.rateLimited = looksRateLimited(combinedOutput);
        reject(err);
        return;
      }
      const expected = path.join(AUDIO_DIR, `${videoId}.opus`);
      if (fs.existsSync(expected)) {
        resolve(expected);
      } else {
        reject(new Error('yt-dlp finished but expected output file was not found'));
      }
    });
  });
}

module.exports = { downloadAudio, AUDIO_DIR };
