"""Optional faster-whisper adapter. JSONL evidence protocol, no semantic summaries."""
import sys
import json
import time
import os
import importlib.metadata

sys.stdout.reconfigure(encoding="utf-8")
sys.stdin.reconfigure(encoding="utf-8")
model = None
model_key = None


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def transcribe(request):
    global model, model_key
    cfg = request["config"]
    from faster_whisper import WhisperModel
    key = json.dumps({k: cfg.get(k) for k in ("model", "device", "computeType", "cpuThreads", "allowDownload", "downloadRoot")}, sort_keys=True)
    before = time.perf_counter()
    reused = model is not None and model_key == key
    if not reused:
        model = WhisperModel(cfg["model"], device=cfg["device"], compute_type=cfg["computeType"],
                             cpu_threads=cfg["cpuThreads"], num_workers=1,
                             local_files_only=not cfg["allowDownload"], download_root=cfg.get("downloadRoot"))
        model_key = key
    loaded = time.perf_counter()
    segments, info = model.transcribe(request["file"], language=cfg.get("language"), task="transcribe",
                                      beam_size=cfg["beamSize"], word_timestamps=cfg["wordTimestamps"],
                                      vad_filter=False, condition_on_previous_text=False)
    count = 0
    for segment in segments:
        count += 1
        item = {"id": f"segment_{count:06d}", "start": segment.start, "end": segment.end,
                "text": segment.text, "final": True,
                "quality": {"source": "faster-whisper", "avgLogprob": segment.avg_logprob,
                            "noSpeechProbability": segment.no_speech_prob, "compressionRatio": segment.compression_ratio}}
        if cfg["wordTimestamps"] and segment.words is not None:
            item["words"] = [{"start": word.start, "end": word.end, "word": word.word,
                              "probability": word.probability} for word in segment.words]
        emit({"id": request["id"], "type": "segments", "segments": [item]})
    emit({"id": request["id"], "type": "done", "result": {
        "backend": "faster-whisper", "engineVersion": importlib.metadata.version("faster-whisper"),
        "runtimeVersion": importlib.metadata.version("ctranslate2"), "model": cfg["model"],
        "device": model.model.device, "computeType": model.model.compute_type,
        "requestedDevice": cfg["device"], "requestedComputeType": cfg["computeType"],
        "language": info.language, "languageProbability": info.language_probability,
        "duration": info.duration, "segmentCount": count,
        "timeBase": "audio_file_seconds", "vadEnabled": False,
        "metrics": {"modelLoadMs": round((loaded-before)*1000), "modelReused": reused,
                    "processingMs": round((time.perf_counter()-before)*1000)}}})


emit({"type": "ready", "protocol": "adaptive-vision-asr-jsonl-v1", "pid": os.getpid()})
for line in sys.stdin:
    try:
        request = json.loads(line)
        if request.get("type") == "close":
            break
        if request.get("type") != "transcribe":
            raise ValueError("Unsupported ASR protocol request")
        transcribe(request)
    except Exception as exc:
        emit({"id": request.get("id") if isinstance(locals().get("request"), dict) else None,
              "type": "error", "error": f"{type(exc).__name__}: {exc}"[:1500]})
