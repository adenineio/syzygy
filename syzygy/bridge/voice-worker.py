#!/usr/bin/env python3
"""Syzygy voice input's persistent transcription worker.

Spawned by bridge/voice.mjs as an ARGV array -- `<venv>/bin/python3
voice-worker.py <models-dir>` -- never a shell string. Loads openai-whisper's
large-v3-turbo model ONCE (measured 15-19s) and keeps it resident for the
life of the process, because paying that cost per utterance would be
absurd.

Protocol: JSON lines on stdin/stdout, one request in flight at a time (this
is a plain blocking loop -- the NEXT line is not read until the current
transcribe() call returns, so no request ever races another one inside this
process; bridge/voice.mjs is what serializes calls from the relay's side).

  ready:    {"ready": true, "device": "mps" | "cpu"}     -- printed once, at startup
  request:  {"id": "...", "wav": "/abs/path.wav", "language": "en"}
  response: {"id": "...", "ok": true, "text": "..."}
         or {"id": "...", "ok": false, "error": "..."}

A malformed line answers an error on that line's (missing or null) id and
does NOT exit -- one bad request must not take the whole worker down while
bridge/voice.mjs has other callers waiting on it.

This worker never calls ffmpeg. whisper.load_audio()/a path argument to
transcribe() shells out to an ffmpeg binary, which is an undeclared system
dependency on top of the venv, and a broken or missing one fails with a
loader error naming nothing to do with audio. The browser already sends
16kHz mono PCM16 WAV, so this worker reads it with the stdlib `wave` module
into a float32 array and hands transcribe() the ARRAY, never a path.

The worker warms itself with one silent dummy transcribe before
announcing ready, because the FIRST call on MPS pays a one-time kernel
compile (measured ~7.8s here, against 0.68s for the same audio immediately
after). Without this warm-up, the first real dictation of every session
would be the slow one -- which reads as the feature being broken, not as a
cold cache.
"""
import json
import sys
import wave

import numpy as np
import torch
import whisper

SAMPLE_RATE = 16000


def read_wav_float32(path):
    """16kHz mono PCM16 in, a float32 array in [-1, 1] out. No ffmpeg."""
    with wave.open(path, 'rb') as w:
        raw = w.readframes(w.getnframes())
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0


def emit(obj):
    sys.stdout.write(json.dumps(obj) + '\n')
    sys.stdout.flush()


def main():
    if len(sys.argv) < 2:
        sys.stderr.write('usage: voice-worker.py <models-dir>\n')
        sys.exit(1)
    models_dir = sys.argv[1]

    device = 'mps' if torch.backends.mps.is_available() else 'cpu'
    model = whisper.load_model('large-v3-turbo', download_root=models_dir, device=device)

    # pay the first-MPS-call cost here, before announcing ready, on a
    # second of silence rather than on the user's first real dictation.
    warm_audio = np.zeros(SAMPLE_RATE, dtype=np.float32)
    model.transcribe(warm_audio, language='en', fp16=(device == 'mps'))

    emit({'ready': True, 'device': device})

    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue
        req_id = None
        try:
            req = json.loads(line)
            req_id = req.get('id') if isinstance(req, dict) else None
            wav_path = req['wav']
            language = req.get('language') or 'en'
        except Exception as e:
            emit({'id': req_id, 'ok': False, 'error': f'bad request: {e}'})
            continue
        try:
            audio = read_wav_float32(wav_path)
            result = model.transcribe(audio, language=language, fp16=(device == 'mps'))
            text = (result.get('text') or '').strip()
            emit({'id': req_id, 'ok': True, 'text': text})
        except Exception as e:
            emit({'id': req_id, 'ok': False, 'error': f'{type(e).__name__}: {e}'})


if __name__ == '__main__':
    main()
