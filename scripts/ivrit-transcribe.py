#!/usr/bin/env python3
"""
ivrit-transcribe.py — Hebrew-optimized audio transcription using ivrit.ai's
faster-whisper model (whisper-large-v3-turbo-ct2).

Usage:
  python3 scripts/ivrit-transcribe.py <audio-file>
  echo <base64-audio> | python3 scripts/ivrit-transcribe.py --stdin --mime audio/ogg

Outputs the transcribed text to stdout. Exit code 0 on success, 1 on failure.
The model is downloaded on first run (~1.5GB) and cached in ~/.cache/huggingface/.

For the 4GB server: uses int8 compute type to minimize memory.
"""

import sys
import os
import tempfile
import argparse

def main():
    parser = argparse.ArgumentParser(description='Hebrew audio transcription via ivrit.ai')
    parser.add_argument('file', nargs='?', help='Audio file path')
    parser.add_argument('--stdin', action='store_true', help='Read base64 audio from stdin')
    parser.add_argument('--mime', default='audio/ogg', help='MIME type when reading from stdin')
    parser.add_argument('--model', default='ivrit-ai/whisper-large-v3-turbo-ct2',
                        help='Model ID (default: ivrit-ai/whisper-large-v3-turbo-ct2)')
    parser.add_argument('--compute-type', default='int8',
                        help='Compute type: int8, float16, float32 (default: int8)')
    args = parser.parse_args()

    if not args.file and not args.stdin:
        parser.error('Provide a file path or --stdin')

    audio_path = args.file
    tmp_file = None

    if args.stdin:
        import base64
        raw = sys.stdin.buffer.read()
        # Try base64 decode; if it fails, treat as raw audio
        try:
            decoded = base64.b64decode(raw)
        except Exception:
            decoded = raw

        ext_map = {
            'audio/ogg': '.ogg',
            'audio/mpeg': '.mp3',
            'audio/mp4': '.m4a',
            'audio/wav': '.wav',
            'audio/x-wav': '.wav',
        }
        ext = ext_map.get(args.mime.split(';')[0].strip(), '.ogg')
        tmp_file = tempfile.NamedTemporaryFile(suffix=ext, delete=False)
        tmp_file.write(decoded)
        tmp_file.close()
        audio_path = tmp_file.name

    try:
        from faster_whisper import WhisperModel

        model = WhisperModel(args.model, compute_type=args.compute_type)
        segments, info = model.transcribe(audio_path, language='he')
        texts = [seg.text for seg in segments]
        result = ' '.join(texts).strip()

        if result:
            print(result)
            sys.exit(0)
        else:
            print('', file=sys.stderr)
            sys.exit(1)
    except Exception as e:
        print(f'Error: {e}', file=sys.stderr)
        sys.exit(1)
    finally:
        if tmp_file and os.path.exists(tmp_file.name):
            os.unlink(tmp_file.name)

if __name__ == '__main__':
    main()
