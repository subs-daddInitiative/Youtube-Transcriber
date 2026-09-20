# YouTube → Audio → Transcript Queue

A desktop app (Electron + React) that takes a list of YouTube videos and, one at a time:
downloads just the audio (smallest practical size), transcribes it with faster-whisper, and
moves to the next video. Fully resumable — closing the app and reopening continues where it
left off. Built for a large Arabic-language video list, but works for any language.

## Requirements

- **Node.js** 18+ and npm
- **Python** 3.10+ with `pip`
- **ffmpeg** on your PATH ([ffmpeg.org](https://ffmpeg.org/download.html))
- **GPU (optional but recommended):** an NVIDIA GPU with recent drivers makes transcription
  dramatically faster. The app auto-detects it — if none is found, it automatically falls back
  to CPU (much slower, but still works; no configuration needed either way).

## Setup

```bash
cd app
npm install
python -m pip install -r requirements.txt
```

The Python install pulls in `faster-whisper`, `yt-dlp`, and (large — a few GB) the CUDA
runtime libraries (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`) used automatically if a GPU is
present; they're simply unused if you don't have one.

## Add your video list

Drop a `.jsonl` file into `app/data/sources/` — one JSON object per line, each needs at least
`video_id` and `url` (see `aqidah-theology.jsonl` for the full shape this project uses,
including `title`, which is used to name the transcript files). You can also use the **Add
Files (.jsonl)** button inside the app to pick files from anywhere and import them without
manually copying.

## Run

```bash
npm start
```

Click **Start / Resume**. The queue view shows every video's status live (Queued →
Downloading → Transcribing → Done/Failed). Failed videos show their error reason and can be
retried individually or all at once. Selected videos can be removed from the queue with
**Remove Selected**. A **Logs** button shows the raw streaming log if you need more detail
than the queue view.

Transcripts land in `app/transcripts/<video title>.txt` and `.srt`. Downloaded audio is kept
(not deleted) in `app/audio/<video_id>.opus` for reuse elsewhere.

## Notes

- The queue is strictly sequential with a delay between downloads to avoid YouTube rate
  limiting. If YouTube does start throttling, the app pauses and retries with backoff
  automatically (capped, so it can't get stuck forever).
- See `CLAUDE.md` for the full design rationale and implementation notes.
