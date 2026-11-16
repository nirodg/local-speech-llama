# Local Speech

Local, private speech-to-text desktop app powered by **llama.cpp** (`llama-server`) using **`ggml-org/Qwen3-ASR-1.7B-GGUF`** (via `-hf`).

## Features
- Compact, frameless desktop UI with system tray (close hides to tray; Show/Exit, Start at login)
- Automatic llama-server detection/start (managed instance) and preferred server URL
- Live dictation (chunked, VAD/silence auto-stop), microphone recording, and audio file transcription
- Configurable defaults (language, auto-stop), global hotkey (hotkey-triggered sessions auto-paste on stop)
- Local history, copy/auto-copy, best-effort auto-paste
- Recordings are not stored (deleted after transcription; leftovers cleaned on launch)

## Requirements
- **Node.js** >= 18 and **npm** (for development/build)
- **llama-server** (llama.cpp) in `PATH` or `/usr/local/lib/ollama/llama-server`
- **ffmpeg** for microphone/webm conversion
- Linux desktop environment (tray/auto-paste/hotkeys are best-effort depending on X11/Wayland and tools like `xdotool`/`wtype`/`ydotool`)

## Run from source
```bash
npm install
npm start
```
> `npm start` runs Electron with `--no-sandbox --disable-gpu` for compatibility.  
> On first managed run, `llama-server -hf ggml-org/Qwen3-ASR-1.7B-GGUF` may download/load the model (network/time required).

## Build Linux packages (AppImage + deb)
A helper script is provided:

```bash
./scripts/build-linux.sh
```

This installs dependencies (if needed) and builds:
- `dist/Local Speech-<version>.AppImage`
- `dist/local-speech_<version>_amd64.deb`

You can also build manually:

```bash
npm ci
npx electron-builder --linux AppImage deb
```

### Run the AppImage
If you hit the Chromium SUID sandbox error, run with:
```bash
chmod +x "Local Speech-"*.AppImage
./"Local Speech-"*.AppImage --no-sandbox --disable-gpu
```

## Notes
- Transcription quality/performance depends on your `llama-server` build, model, and hardware.
- “Start at login” is available for installed/packaged builds.
