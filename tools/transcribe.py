#!/usr/bin/env python3
"""Optional faster-whisper sidecar used by the Node MVP when --transcribe is set."""

import argparse
import json
import os
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default=os.environ.get("FASTER_WHISPER_LANGUAGE", "auto"))
    parser.add_argument("--device", default="cpu")
    parser.add_argument("--compute-type", default="int8")
    args = parser.parse_args()

    try:
        from faster_whisper import WhisperModel
    except ImportError as exc:
        raise SystemExit("缺少 faster-whisper。请先安装后再使用 --transcribe。") from exc

    model = WhisperModel(args.model, device=args.device, compute_type=args.compute_type)
    language = None if args.language.strip().lower() in {"", "auto", "detect"} else args.language.strip()
    segments, info = model.transcribe(
        str(Path(args.input)),
        language=language,
        vad_filter=True,
        word_timestamps=True,
    )
    result = [
        {"start": float(segment.start), "end": float(segment.end), "text": segment.text.strip(),
         "words": [{"start": float(word.start), "end": float(word.end), "word": word.word,
                    "probability": float(word.probability)} for word in (segment.words or []) if word.end > word.start]}
        for segment in segments
        if segment.end > segment.start
    ]
    Path(args.output).write_text(
        json.dumps({"provider": "faster-whisper", "analysis_version": "words-v1", "word_timestamps": True, "language": info.language, "language_probability": info.language_probability, "segments": result}, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
