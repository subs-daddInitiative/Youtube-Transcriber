# Transcript Audio From YouTube — Project Plan

## Goal
Given a list of YouTube videos in [aqidah-theology.jsonl](aqidah-theology.jsonl) (1574 entries, Arabic content,
one JSON object per line with `video_id`, `title`, `url`, `duration_seconds`, etc.), for each video:

1. Download only the **audio**, at the **smallest file size / bitrate that still transcribes reliably** (we are
   bandwidth-constrained, not quality-constrained — this is speech, not music).
2. Transcribe that audio into a transcript file (text + timestamps).
3. Move to the next video in the list.

This must run as a **queue, one video at a time** (not in parallel), because YouTube starts throwing HTTP 429 /
"too many requests" errors when we hammer it with downloads back-to-back.

## Hard constraints learned from the data
- Content is **Arabic** (`"language": "ar"`), so the transcription model/config must be set for Arabic, not
  auto-English.
- 1574 videos, durations vary (this sample: ~32 min). At scale, audio-only + low bitrate is essential to keep
  total disk/bandwidth down.
- Hardware available: **RTX 3060 12GB VRAM**, **24GB system RAM**. Plan must actually use the GPU for
  transcription (CPU-only Whisper would be far too slow for 1500+ videos).

## Existing prior work to evaluate first
There's a folder from earlier experiments: `G:\Download\SubsTQ\Website Files\_Whisper` containing leftover
output from what looks like OpenAI Whisper (CLI) runs: `.aac`/`.mp3`/`.m4a` audio + matching `.json`, `.srt`,
`.tsv`, `.txt`, `.vtt` per file (e.g. `CZOZ.*`, `freewebsite.*`, `test.*`).

**Before building anything new**, check/reuse this setup:
- Confirm whether it's plain `openai-whisper`, `faster-whisper`, or `whisper.cpp` based on the exact output
  format/flags (the `.tsv` + `.vtt` + `.srt` + `.json` bundle strongly suggests the official `openai-whisper`
  CLI, which emits exactly those four plus `.txt`).
- Check if it already runs on GPU (look for CUDA/cuDNN install, check if a run uses the 3060).
- Test it on one video end-to-end before deciding to replace it.
- Decide keep vs. replace based on: does it use the GPU, does it support Arabic well, is it fast enough per
  1500-video scale, is it still installed/working (packages might be stale/broken since May).

### Likely replacement if the old setup is inadequate
`faster-whisper` (CTranslate2-based) is the standard upgrade path from plain `openai-whisper`: same accuracy,
much faster on the same GPU, lower VRAM use (a `large-v3` or `large-v3-turbo` model fits comfortably in 12GB
with int8/float16 compute type), and has solid Arabic support. This is the fallback plan if testing the old
Whisper folder shows it's unusable or too slow — not decided yet, to be confirmed by testing first.

## Pipeline design (queue, sequential, one video at a time)

For each video in the jsonl, in order:

1. **Download audio only, smallest usable size**
   - Use `yt-dlp` with `-f bestaudio` but capped/converted to a low-bitrate mono format suited for speech
     (e.g. extract to a compressed format at a low bitrate — speech intelligibility holds up fine well below
     music-quality bitrates). Exact format/bitrate to be decided together, but the intent is: whatever is
     smallest while Whisper still transcribes it accurately.
   - Save to a temp/working location, not permanently, since we only need audio long enough to transcribe it.
2. **Transcribe**
   - Run the chosen Whisper variant against the downloaded audio, Arabic language explicitly set, using the
     GPU.
   - Save the resulting transcript (format still to be decided: plain `.txt`, `.srt` with timestamps, or both)
     into an output folder, named by `video_id` (matching the jsonl's `video_id` field so we can always map
     transcript ↔ source video ↔ metadata).
3. **Retry-once-then-skip-forward logic**
   - If transcription of the current video's audio **fails**, retry transcription **one more time** on the
     same audio file (no re-download).
   - If it fails **again** on the retry, give up on that video for now, log it as failed, and move on to
     **download the next video** in the list (don't get stuck).
   - Track failed video_ids somewhere (e.g. a `failed.jsonl` or status field) so they can be revisited later.
4. **Delete the downloaded audio** once transcription succeeds (or once we've given up after the retry) to
   keep disk usage bounded across 1574 videos — we don't need to keep the audio, only the transcript.
5. **Progress tracking / resumability**
   - Since this is a long-running job over 1574 videos, it must be resumable: keep a persisted state (e.g. a
     `progress.json`/sqlite/status column) of which video_ids are done / failed / pending, so if the script
     stops (crash, YouTube block, manual interrupt) it can pick up where it left off instead of re-processing
     everything.
6. **Rate limiting to avoid YouTube blocks**
   - Strictly sequential: never download video N+1 until video N's download has finished.
   - Add a deliberate delay/backoff between downloads (exact interval to be tuned — start conservative).
   - If a download itself fails with a rate-limit-looking error (HTTP 429 / "Sign in to confirm" / etc.),
     back off with an increasing delay and retry, rather than plowing ahead.

## Decisions made
- **DB**: SQLite (`app/data/queue.db`, via `better-sqlite3`) — single file, no server, copy the `app/` folder to
  any machine and it works.
- **Whisper engine**: `faster-whisper`, model `large-v3-turbo`, `device="cuda"`, `compute_type="float16"` (fits
  the 3060's 12GB comfortably).
- **Audio**: `yt-dlp -f worstaudio/worst -x --audio-format opus` downsampled to mono 16kHz / 32kbps via ffmpeg
  postprocessor args — smallest practical size for speech-only transcription.
- **Transcript output**: both `.txt` and `.srt` per video, in `app/transcripts/<video_id>.*`.
- **Stack**: Electron + React (no bundler — React/ReactDOM UMD builds loaded straight from `node_modules`,
  renderer code is plain JS `React.createElement`) + Node.js main process + SQLite.

## Implementation (`app/`)
- `src/main/db.js` — schema + `importJsonlDir()`, which ingests **every** `*.jsonl` file placed in
  `app/data/sources/`, insert-or-ignore by `video_id`. To feed it more lists in the future, just drop another
  `.jsonl` file (same shape as `aqidah-theology.jsonl`) into that folder and restart, or use the reimport IPC call.
- `src/main/downloader.js` — spawns `yt-dlp` for one video's audio.
- `src/main/transcriber.js` — spawns `python scripts/transcribe.py` (faster-whisper) for one audio file.
- `src/main/queue.js` — the sequential worker: pulls the next `pending` row, downloads, transcribes (retry once
  on failure, then mark `failed` and move on), logs every step to `logs/run.log` and to the renderer, waits
  `DOWNLOAD_DELAY_MS` (3s) before the next video to avoid YouTube rate-limiting. Downloaded audio is kept
  permanently in `app/audio/<video_id>.opus` (not deleted) for reuse in other plans; its path is recorded in
  the `audio_path` column.
- `src/main/index.js` — Electron entry point, imports jsonl on boot, resets any row stuck mid-`downloading`/
  `transcribing` back to `pending` (crash/interrupt recovery), wires IPC.
- `src/renderer/` — shows live logs, per-status counts, current video/stage, Start/Resume and Pause buttons.
- Resumability: progress lives entirely in `queue.db`'s `status` column (`pending → downloading → transcribing
  → done`/`failed`). Closing the app and reopening + clicking Start/Resume continues from the first `pending`
  row; nothing is reprocessed.
- Rate-limit handling: `downloader.js` scans yt-dlp's output for throttling/bot-check signatures (HTTP 429,
  "Too Many Requests", "sign in to confirm"/"confirm you're not a bot"). When detected, the queue does **not**
  mark the video failed — it pauses on that same video and retries it after a backoff (1min → 5min → 15min,
  capped), which blocks the whole sequential loop until it clears. Ordinary per-video errors (deleted video,
  no audio track, etc.) still go to `failed` immediately.
- Failed videos: a per-row "Retry" button (`Queue.startRetry([id])`) retries just that one video, and a
  top "Retry All Failed (N)" button (`Queue.startRetryFailed()`) retries every failed row — both reset only
  the targeted rows to `pending` and process just that batch (`restrictIds`), leaving the rest of the queue
  untouched. Anything that succeeds moves to `done` and drops out of the failed count/list automatically.
- Transcript filenames: derived from the video title, not the video_id (`src/main/naming.js`) — emoji and
  Windows-illegal characters stripped, collisions disambiguated with " (2)", " (3)", etc. The chosen name is
  saved once in `filename_base` and reused on every retry so it never changes underneath a file. Videos that
  were already `done` before this existed get their transcript files renamed automatically on next launch
  (`migrateDoneFilenames()` in db.js). Audio files in `app/audio/` are still named by `video_id` (unaffected).
- UI: default view is a live per-video queue list (title + status badge: Queued/Downloading/Transcribing/
  Done/Failed, with a Retry button on failed rows), fed by `queue:list` on load and patched incrementally via
  `queue:item` events per status change — not a full list refetch each time. A "Logs" button swaps to the
  raw streaming log view (same content as `logs/run.log`).

## Known Whisper hallucination
Arabic Whisper models (including `large-v3-turbo`) are trained on huge amounts of subtitled Arabic TV/film
content, so on silence or low-information audio (trailing outro, background noise) they sometimes hallucinate
a plausible-looking subtitler credit line instead of transcribing nothing. The one we've actually hit is
"ترجمة نانسي قنقر" ("Translation by Nancy Qanqar"), usually as the last segment of a transcript.
Mitigations in `scripts/transcribe.py`: `condition_on_previous_text=False` (stops one hallucinated line from
seeding more), `hallucination_silence_threshold=2.0` (faster-whisper's own silence-hallucination detector),
plus an explicit `KNOWN_HALLUCINATIONS` phrase filter dropped from the output. `scripts/strip-hallucination.js`
is a rerunnable one-off cleanup for transcripts generated before this filter existed — extend its `BAD_PHRASE`
(and the Python list, to stay in sync) if a new recurring hallucination shows up.

## Setup on a new machine
1. `cd app && npm install`
2. `python -m pip install -r requirements.txt` (installs `faster-whisper` + `yt-dlp`)
3. Make sure `ffmpeg` is on PATH and the NVIDIA/CUDA driver is installed.
4. Put your `.jsonl` file(s) in `app/data/sources/`.
5. `npm start`, click Start/Resume.
