import argparse
import importlib.util
import os
import sys


def _add_nvidia_dll_dirs():
    """Pip-installed nvidia-cublas-cu12 / nvidia-cudnn-cu12 ship their DLLs inside the
    package instead of a system CUDA Toolkit install; point Windows' DLL loader at them.
    Both add_dll_directory AND prepending to PATH are needed: some of ctranslate2's
    dependency chain resolves DLLs via plain LoadLibrary, which only honors PATH."""
    if os.name != "nt":
        return
    for pkg in ("nvidia.cublas", "nvidia.cudnn"):
        spec = importlib.util.find_spec(pkg)
        if not spec or not spec.submodule_search_locations:
            continue
        for base in spec.submodule_search_locations:
            bin_dir = os.path.join(base, "bin")
            if os.path.isdir(bin_dir):
                os.add_dll_directory(bin_dir)
                os.environ["PATH"] = bin_dir + os.pathsep + os.environ.get("PATH", "")


_add_nvidia_dll_dirs()

# stdout/stderr may be a pipe (Electron) or a non-UTF-8 console codepage; Arabic text must not crash printing.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")
sys.stderr.reconfigure(encoding="utf-8", errors="replace")

from faster_whisper import WhisperModel
import ctranslate2


def pick_device_and_compute_type(requested_device: str, requested_compute_type: str):
    """Auto-detects whether a usable NVIDIA GPU is present so this runs unmodified on a
    machine without one (CPU, much slower) instead of crashing. `requested_device` of
    "cuda"/"cpu" is honored as an explicit override; "auto" (the default) detects."""
    if requested_device != "auto":
        return requested_device, requested_compute_type
    try:
        gpu_count = ctranslate2.get_cuda_device_count()
    except Exception:
        gpu_count = 0
    if gpu_count > 0:
        return "cuda", requested_compute_type
    print("[transcribe] no CUDA GPU detected, falling back to CPU (this will be much slower)", flush=True)
    return "cpu", "int8"


def format_timestamp(seconds: float) -> str:
    ms = int(round(seconds * 1000))
    h, ms = divmod(ms, 3_600_000)
    m, ms = divmod(ms, 60_000)
    s, ms = divmod(ms, 1000)
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


# Whisper's Arabic training data is full of subtitled TV/film content, so on silence or
# non-speech audio (trailing outro, background noise) it sometimes hallucinates a plausible
# subtitler credit line instead of transcribing nothing. These are the recurring ones we've
# actually seen; strip them as a last-resort filter on top of the model's own suppression.
KNOWN_HALLUCINATIONS = [
    "ترجمة نانسي قنقر",
]


def is_hallucination(text: str) -> bool:
    stripped = text.strip()
    return any(h in stripped and len(stripped) < len(h) + 15 for h in KNOWN_HALLUCINATIONS)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--out-txt", required=True)
    parser.add_argument("--out-srt", required=True)
    parser.add_argument("--language", default="ar")
    parser.add_argument("--model", default="large-v3-turbo")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="float16")
    args = parser.parse_args()

    device, compute_type = pick_device_and_compute_type(args.device, args.compute_type)
    print(f"[transcribe] loading model {args.model} on {device} ({compute_type})", flush=True)
    try:
        model = WhisperModel(args.model, device=device, compute_type=compute_type)
    except Exception as e:
        if device == "cuda":
            print(f"[transcribe] CUDA load failed ({e}); retrying on CPU", flush=True)
            model = WhisperModel(args.model, device="cpu", compute_type="int8")
        else:
            raise

    print(f"[transcribe] transcribing {args.audio}", flush=True)
    segments, info = model.transcribe(
        args.audio,
        language=args.language,
        vad_filter=True,
        condition_on_previous_text=False,  # stops one hallucinated line from seeding more of them
        hallucination_silence_threshold=2.0,  # drop segments faster-whisper itself flags as silence-hallucination
    )

    lines_txt = []
    lines_srt = []
    seg_num = 0
    for seg in segments:
        text = seg.text.strip()
        if is_hallucination(text):
            print(f"[transcribe] dropped likely hallucination at {seg.start:.1f}-{seg.end:.1f}: {text}", flush=True)
            continue
        seg_num += 1
        lines_txt.append(text)
        lines_srt.append(str(seg_num))
        lines_srt.append(f"{format_timestamp(seg.start)} --> {format_timestamp(seg.end)}")
        lines_srt.append(text)
        lines_srt.append("")
        print(f"[transcribe] segment {seg_num}: {seg.start:.1f}-{seg.end:.1f}", flush=True)

    os.makedirs(os.path.dirname(args.out_txt) or ".", exist_ok=True)
    os.makedirs(os.path.dirname(args.out_srt) or ".", exist_ok=True)

    with open(args.out_txt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines_txt))

    with open(args.out_srt, "w", encoding="utf-8") as f:
        f.write("\n".join(lines_srt))

    print("[transcribe] done", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
