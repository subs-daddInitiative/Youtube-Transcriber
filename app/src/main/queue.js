const fs = require('fs');
const path = require('path');
const { downloadAudio } = require('./downloader');
const { transcribe, TRANSCRIPTS_DIR } = require('./transcriber');
const { sanitizeFilename, uniqueBaseName } = require('./naming');
const {
  nextPending,
  nextPendingAmong,
  getFailed,
  resetToPending,
  setStatus,
  incrementAttempts,
  getCounts,
  resetInFlight,
} = require('./db');

const LOG_PATH = path.join(__dirname, '..', '..', 'logs', 'run.log');
const DOWNLOAD_DELAY_MS = 3000; // be polite to YouTube between downloads

// Backoff schedule used when YouTube looks like it's throttling/bot-checking us: retry the
// SAME video after an increasing wait instead of counting it as a permanent failure.
const RATE_LIMIT_BACKOFF_MS = [60_000, 5 * 60_000, 15 * 60_000];
// Safety net: if something is misclassified as rate-limiting (it will never actually clear),
// don't retry it forever — give up and move on after this many backoff rounds.
const MAX_RATE_LIMIT_RETRIES = 6;

class Queue {
  constructor(db, onEvent) {
    this.db = db;
    this.onEvent = onEvent; // (type, payload) => void, sent to renderer
    this.running = false;
    this.stopRequested = false;
    this.restrictIds = null; // when set (retrying only specific videos), only these video_ids are processed
  }

  log(line) {
    const stamped = `[${new Date().toISOString()}] ${line}`;
    fs.mkdirSync(path.dirname(LOG_PATH), { recursive: true });
    fs.appendFileSync(LOG_PATH, stamped + '\n');
    this.onEvent('log', stamped);
  }

  emitState(extra = {}) {
    this.onEvent('state', {
      running: this.running,
      counts: getCounts(this.db),
      failed: getFailed(this.db),
      ...extra,
    });
  }

  /** Updates a video's DB status and pushes a lightweight per-row update to the renderer's list view. */
  applyStatus(videoId, status, extra = {}) {
    setStatus(this.db, videoId, status, extra);
    this.onEvent('item', {
      video_id: videoId,
      status,
      error: 'error' in extra ? extra.error : undefined,
      transcript_txt_path: 'transcript_txt_path' in extra ? extra.transcript_txt_path : undefined,
    });
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.stopRequested = false;
    this.restrictIds = null;
    resetInFlight(this.db);
    this.log('Queue started. Resuming from first pending video.');
    this.emitState();
    this.loop();
  }

  /** Resets the given video_ids to pending and processes ONLY those, leaving the rest of the queue untouched. */
  async startRetry(ids) {
    if (this.running) return;
    if (!ids || ids.length === 0) return;
    resetToPending(this.db, ids);
    for (const id of ids) this.onEvent('item', { video_id: id, status: 'pending', error: null });
    this.running = true;
    this.stopRequested = false;
    this.restrictIds = ids;
    this.log(`Retrying ${ids.length} video(s): ${ids.join(', ')}`);
    this.emitState();
    this.loop();
  }

  async startRetryFailed() {
    const failedRows = getFailed(this.db);
    if (failedRows.length === 0) {
      this.log('Retry requested but there are no failed videos.');
      this.emitState();
      return;
    }
    return this.startRetry(failedRows.map((r) => r.video_id));
  }

  stop() {
    this.stopRequested = true;
    this.log('Stop requested — will pause after the current video finishes.');
  }

  async loop() {
    while (!this.stopRequested) {
      const video = this.restrictIds ? nextPendingAmong(this.db, this.restrictIds) : nextPending(this.db);
      if (!video) {
        this.log(this.restrictIds ? 'Retry batch complete.' : 'No pending videos left. Queue idle.');
        this.restrictIds = null;
        break;
      }
      await this.processOne(video);
      this.emitState({ current: null });
      await sleep(DOWNLOAD_DELAY_MS);
    }
    this.running = false;
    this.emitState();
  }

  async processOne(video) {
    const { video_id: id, url, title } = video;
    this.log(`--- Processing ${id} (${title || 'no title'}) ---`);
    this.emitState({ current: { video_id: id, title, stage: 'downloading' } });
    this.applyStatus(id, 'downloading');

    let audioPath;
    let rateLimitAttempt = 0;
    while (true) {
      try {
        audioPath = await downloadAudio(url, id, (l) => this.log(`[dl:${id}] ${l.trim()}`));
        this.log(`Downloaded audio for ${id} -> ${audioPath}`);
        break;
      } catch (err) {
        if (err.rateLimited && !this.stopRequested && rateLimitAttempt < MAX_RATE_LIMIT_RETRIES) {
          const waitMs = RATE_LIMIT_BACKOFF_MS[Math.min(rateLimitAttempt, RATE_LIMIT_BACKOFF_MS.length - 1)];
          rateLimitAttempt += 1;
          this.log(
            `YouTube looks like it's rate-limiting/bot-checking us. Pausing the queue for ${Math.round(
              waitMs / 1000,
            )}s before retrying ${id} (attempt ${rateLimitAttempt}/${MAX_RATE_LIMIT_RETRIES}; this does not count as a failure).`,
          );
          this.applyStatus(id, 'pending');
          this.emitState({ current: { video_id: id, title, stage: 'rate-limited-wait' } });
          await sleep(waitMs);
          if (this.stopRequested) return;
          this.applyStatus(id, 'downloading');
          continue;
        }
        if (err.rateLimited) {
          this.log(`Gave up on ${id} after ${MAX_RATE_LIMIT_RETRIES} rate-limit retries without success.`);
        }
        this.log(`Download FAILED for ${id}: ${err.message}`);
        this.applyStatus(id, 'failed', { error: `download: ${err.message}` });
        return;
      }
    }

    // filename_base is computed once from the title and reused on every future retry, so a
    // video never ends up with two different transcript filenames across attempts.
    let filenameBase = video.filename_base;
    if (!filenameBase) {
      filenameBase = uniqueBaseName(TRANSCRIPTS_DIR, sanitizeFilename(title, id));
    }
    this.applyStatus(id, 'transcribing', { filename_base: filenameBase });
    this.emitState({ current: { video_id: id, title, stage: 'transcribing' } });

    const maxAttempts = 2; // first try + one retry
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      incrementAttempts(this.db, id);
      try {
        const result = await transcribe(audioPath, filenameBase, (l) => this.log(`[asr:${id}] ${l.trim()}`));
        this.log(`Transcription OK for ${id} -> ${result.txt}`);
        this.applyStatus(id, 'done', {
          transcript_txt_path: result.txt,
          transcript_srt_path: result.srt,
          audio_path: audioPath,
          error: null,
        });
        return;
      } catch (err) {
        lastErr = err;
        this.log(`Transcription attempt ${attempt}/${maxAttempts} FAILED for ${id}: ${err.message}`);
      }
    }

    this.log(`Giving up on ${id} after ${maxAttempts} transcription attempts. Moving to next video.`);
    this.applyStatus(id, 'failed', {
      error: `transcribe: ${lastErr ? lastErr.message : 'unknown'}`,
      audio_path: audioPath,
    });
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

module.exports = { Queue };
