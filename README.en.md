# video-sense · 动态视听

English | [简体中文](README.md)

**Inspectable, traceable video and audio evidence for AI agents.**

video-sense is a local MCP server with an optional, host-neutral Skill. Give it video or audio and receive adaptively selected images, original subtitles or speech transcripts, timestamps, provenance and processing status. Your agent interprets that evidence to answer your question.

Current version: **0.8.0**. The installation scripts and distribution target **Windows**. Any compatible stdio MCP client can connect; Codex and WorkBuddy are examples, not runtime requirements. macOS/Linux installation has not been validated as a supported experience.

## Features

- **Video evidence:** local files, HTTP(S) media URLs and on-demand pages supported by yt-dlp. Analyze a range, process continuously, take a sparse overview or inspect a specific time.
- **Independent audio:** open audio without creating a video job. Import matching subtitles/external transcripts or use optional local faster-whisper ASR.
- **Streaming first:** read network media incrementally; after bounded recovery attempts fail, optionally download the corresponding complete track for local processing.
- **Efficient image delivery:** JPEG by default, up to 12 storyboards and 8MiB of encoded image bytes per batch. Original PNGs remain available for checking fine text and diagrams. A storyboard can contain multiple frames.
- **Shared installation:** one runtime source tree and one generic Skill, with separate client configurations, task data and processes.

## How it works

Continuous analysis uses one FFmpeg process to decode video, selects frames adaptively from color and motion changes, and assembles timestamped images. The host agent chooses text, selected images, all images or targeted follow-up based on the question and evidence gaps.

The MCP server returns **evidence, not image descriptions, summaries, semantic event tags or causal judgments**. Interpretation belongs to the host agent. Generation, delivery and inspection are separate states; the receipt protocol records the caller's inspection claims rather than proving comprehension.

Adaptive sampling is not exhaustive frame-by-frame inspection and may miss brief changes. Fine-grained, high-frequency extraction is a slower option requiring separate tools. Screen capture, live viewing companionship, microphone capture and system-audio capture are not provided.

## Windows installation

### 1. Prepare dependencies

- **Node.js 20+**.
- **FFmpeg and FFprobe**, available on PATH or supplied by explicit paths.
- A client supporting stdio MCP. Visual workflows additionally require image delivery to a vision-capable model.
- Optional ASR: separately installed Python, faster-whisper and model files. Visual analysis and imported text do not require ASR.

Download the portable ZIP from this repository's Releases and extract it to a stable shared location, such as `D:\AgentTools\video-sense`. It includes production npm dependencies and Windows yt-dlp, but not Node, FFmpeg, Python or ASR models.

For a source checkout, run `npm ci --omit=dev` in the repository before continuing.

### 2. Generate separate client configurations

Open PowerShell in the package directory:

```powershell
.\install.ps1 -ConfigDir 'D:\AgentA\config\video-sense'
.\configure.ps1 -ConfigDir 'D:\AgentB\config\video-sense'
```

Each command generates an `mcp.json` snippet. **The scripts do not edit the host's main configuration.** Merge the `video-sense` entry into each client's MCP configuration, then reconnect or restart. Both clients launch the same `src/bootstrap.mjs`, while keeping separate data directories.

Optional client presets:

```powershell
.\configure.ps1 -Client codex
.\configure.ps1 -Client workbuddy
```

These generate `.codex/video-sense/mcp.toml` and `.workbuddy/video-sense/mcp.json` under your user directory, respectively. Merge the generated entry into the host configuration. Use `-NodePath`, `-FfmpegPath` and `-FfprobePath` if dependencies are not on PATH.

For manual setup, configure a stdio server whose `command` is your Node executable and whose `args` contains the absolute path to the shared `src/bootstrap.mjs`. Set `AGENT_VIDEO_CONFIG_DIR` and `AGENT_VIDEO_DATA_DIR` to client-owned directories. Optionally set `AGENT_VIDEO_FFMPEG`, `AGENT_VIDEO_FFPROBE` and `AGENT_VIDEO_YTDLP` to executable paths. Each client may use a different configuration directory. Moving the shared package requires regenerating the paths.

### 3. Verify the connection

Ask the agent to call `video_doctor` and verify the version and dependencies, then `video_help` for the complete workflow and data contracts. An unconfigured ASR backend does not disable images or subtitle imports.

### 4. Optional generic Skill

The MCP works independently. The Skill helps discover capabilities and choose evidence; it does not depend on a particular model, host hook or developer path.

```powershell
.\install.ps1 -ConfigDir 'D:\AgentA\config\video-sense' -SkillDir 'D:\SharedSkills\video-sense'
```

Configure each host to discover this shared directory. Windows clients that support directory junctions can reference it with `mklink /J`; use the actual skill-directory location required by your client. Installing a Skill does not automatically register the MCP server.

## Example prompts

> Explain the demonstration in D:\Videos\demo.mp4, combining the narration and visible steps.
>
> Analyze this video URL. Focus on the charts between 02:00 and 04:00 and changes the narration does not explain.
>
> Transcribe the first three minutes of this audio file and retain timestamps.

The host decides whether ASR is needed and which images to inspect. Not every task requires reading every storyboard.

## Optional ASR and data

Adapt `config/asr.example.json` to your Python/model installation and save it as `ConfigDir/asr.json`, or pass `-AsrConfig` to select another file. Models are not downloaded automatically. A missing default file means ASR is unconfigured; a missing explicitly configured file is an error.

Task data defaults to `ConfigDir/data`; override it with `-DataDir`. Network resolution accesses source sites. The MCP does not invoke a cloud understanding model itself, but its returned evidence is passed to the host agent and handled according to that host's settings. Keep credentials, private configurations, media caches and transcripts out of public repositories.

## Limitations and troubleshooting

- Website support, authenticated content, DRM and live streams are not guaranteed; respect source access permissions.
- Adaptive sampling and ASR can omit or misinterpret information. Mechanical timestamp intersections do not prove semantic relationships.
- Reconnect/restart the client after runtime or configuration changes.
- Use `video_doctor` to check dependencies and `video_help` for current schemas, workflows and output meanings.
- JPEG encoding has bounded concurrency, timeouts and cancellation; no fixed end-to-end speed improvement is promised.

## Documentation and development

- [Chinese introduction](README.md)
- [Detailed Windows installation guide (Chinese)](PORTABLE-README.md)
- [MCP tools and workflows](MCP-GUIDE.md)
- [Audio, subtitles and ASR](AUDIO-TEXT.md)
- [Generic Skill](skills/video-sense/SKILL.md)
- [Release notes / validation scope](CHANGELOG.md)

Run `npm ci` for development dependencies and `npm test` for tests. FFmpeg/FFprobe are required; real-ASR tests need additional environment setup. The MCP tool descriptions and `video_help` remain the authoritative runtime interface.

## Attribution and license

The adaptive selection and storyboard core derives from [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now). Pinned source and modifications are recorded in [UPSTREAM.json](UPSTREAM.json). This project adds independent MCP integration, audio/text workflows, image delivery, a generic Skill and shared installation support.

**Licensed under PolyForm Noncommercial 1.0.0, not GPLv3.** See [LICENSE](LICENSE) and [third-party notices](THIRD_PARTY.md). This license does not permit unrestricted commercial use. Dependencies retain their own licenses; the upstream commercial-license notice is preserved.
