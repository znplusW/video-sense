# 动态视听 video-sense 0.9.0 共享安装包

将工具包整体解压到一个共享目录。任意支持标准 stdio MCP 的 Agent 都可以从该目录启动服务；只需一份源码和依赖，各客户端保留自己的 MCP 配置和任务目录；ASR 配置可以分别保存，也可共同引用一份外置 JSON。多个客户端通常各自启动一个进程；“共用源码”不表示共用进程或阅读确认状态。

本工具获取本地及网络音视频证据，不采集当前屏幕、不跟随播放器进度。视频仍是连续解码、自适应选帧和组图；图片交付使用受管理的异步 FFmpeg 转码生成 JPEG，保留 PNG 原图和缓存。MCP 可独立使用，通用 Skill 仅辅助能力发现与取证选择。0.9.0 只接受媒体输入，画面、同源字幕和 ASR 三类数据独立按需选择；外部转写由 Agent 直接使用，不导入 MCP，文字阅读进度不进入图片完成检查。只取文字时可用 audio 入口打开音视频源，不创建图片任务。MCP 中字幕与 ASR 并列，Agent 按任务选择其一或两者；不自动双跑，不由 MCP 合并或裁决可信度。Skill 的默认取证顺序是先用可获取且来源可靠的字幕理解语言内容；字幕缺失、覆盖不足、不可靠，或任务需要核对时再使用 ASR 文本，也可保留双轨对照。这是宿主建议，不是 MCP 强制规则。

## Windows 安装与接入

1. 准备 Node.js 20+、FFmpeg 和 FFprobe，放入 PATH 或下述可选 runtime 目录。包内不附带这些可执行文件或 ASR 模型。
2. 在共享包目录运行下面的命令，把 `-ConfigDir` 换成所用 Agent 的配置目录。该脚本只生成配置片段，不替换宿主主配置，也不复制运行代码。
3. 将生成的 `mcp.json` 中 `video-sense` 条目合并到客户端自己的 MCP 配置；字段包装形式以宿主要求为准，核心是 `command`、`args` 和 `env`。重连后用 `video_doctor` 确认版本0.9.0及依赖，再发现工具。

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -ConfigDir 'D:\Agent-A\config\video-sense'
powershell -NoProfile -ExecutionPolicy Bypass -File .\configure.ps1 -ConfigDir 'D:\Agent-B\config\video-sense'
```

两个片段的 `args` 都指向同一共享包的 `src/bootstrap.mjs`，数据分别属于 Agent A 和 Agent B；ASR 可以各自配置或共享。安装时不会自动下载软件或模型，也不自动启用hook。

省略参数时，默认 `-Client generic`，配置写入用户 `~/.config/video-sense/generic`（设置了 `XDG_CONFIG_HOME` 时优先使用它）。为多个客户端接入时应分别传入其 `-ConfigDir`，避免共用同一个默认配置目录。

Codex、WorkBuddy 是可选格式预设，不是运行依赖：

```powershell
# 生成 ~/.codex/video-sense/mcp.toml，由用户合并到相应宿主配置
.\configure.ps1 -Client codex
# 生成 ~/.workbuddy/video-sense/mcp.json
.\configure.ps1 -Client workbuddy
```

配置目录还会保存 `client-config.json`，记录这次选择的共享入口、数据目录和ASR位置，便于审阅。重新生成已有片段时先保存带唯一后缀的 `.bak`；不会改客户端的其他服务。`-OutputDir` 是 `-ConfigDir` 的兼容别名，不可同时传入。配置目录及数据目录必须位于共享包之外。

```text
video-sense/
  start.cmd
  install.ps1
  runtime/          可选，由接收方放入依赖
    node.exe
    ffmpeg.exe
    ffprobe.exe
  src/bootstrap.mjs
  node_modules/     已包含，无需npm install
  skills/video-sense/ 通用辅助Skill，可让多个Agent共同发现
  tools/yt-dlp.exe  Windows解析器及许可已包含
```

也支持 runtime/node/node.exe、runtime/ffmpeg/bin/ffmpeg.exe 和 ffprobe.exe。可用 `-NodePath`、`-FfmpegPath`、`-FfprobePath` 显式指定依赖。`-DataDir` 指定该客户端的数据目录，默认是其 `ConfigDir/data`。

`start.cmd` 启动 MCP，`start.cmd --cli doctor` 诊断；未提供环境设置时使用 generic 默认配置/数据目录。移动共享包后，重新为各客户端生成片段，使入口指向新位置。

## 通用 Skill

安装 MCP 不强制安装 Skill。可直接让支持自定义技能目录的宿主发现 `skills/video-sense`，或显式指定一个共享 Skill 目录：

```powershell
.\install.ps1 -ConfigDir 'D:\Agent-A\config\video-sense' -SkillDir 'D:\Shared-Agent-Skills\video-sense'
```

已有目录先备份。脚本不创建客户端私有Skill副本，不向Skill写入客户端配置或运行位置。各宿主可指向这个共享目录；需要目录联接的Windows宿主，可在确认目标路径后使用 `mklink /J`。同一共享Skill只需安装一次，后续客户端只运行 `configure.ps1`。`-SkipSkill` 保留兼容，默认未传 `-SkillDir` 时本来就不复制Skill。

## 数据和可选ASR

客户端片段设置 `AGENT_VIDEO_CONFIG_DIR` 和 `AGENT_VIDEO_DATA_DIR`。ASR默认检查该客户端配置目录的 `asr.json`，文件不存在表示未配置，不影响纯视觉或同源网络字幕获取。`config/asr.example.json` 只是占位示例；需要ASR时按 AUDIO-TEXT.md 配置本机 Python 和模型，保存到客户端目录，或用 -AsrConfig 指向共同的外置 JSON。

`-AsrConfig` 可以显式指定其他ASR配置文件；相对路径以 `ConfigDir` 为基准。只有显式传入时，生成片段才添加 `AGENT_VIDEO_ASR_CONFIG`。显式指定的路径不存在会报告配置错误，不会静默采用共享包内配置或自动安装模型。

ASR 由 MCP 调用配置的后端执行，不需要每个 Agent 重复安装。多个客户端可以把 AGENT_VIDEO_ASR_CONFIG 指向同一个外置共享 JSON，共用同一 Python 环境和模型文件；也可各用不同配置。各 MCP 进程仍可能分别加载模型，这不是共享的常驻 ASR 服务，内存占用不会因此自动合并。

```powershell
.\configure.ps1 -ConfigDir 'D:\AgentA\config\video-sense' -AsrConfig 'D:\SharedConfig\video-sense-asr.json'
.\configure.ps1 -ConfigDir 'D:\AgentB\config\video-sense' -AsrConfig 'D:\SharedConfig\video-sense-asr.json'
```

其他系统可手工接入标准 stdio：`command` 为本机 Node 可执行文件，`args` 为共享包 `src/bootstrap.mjs` 的绝对路径，`env` 指定各自的配置、数据和FFmpeg/FFprobe路径；可按需设置 `AGENT_VIDEO_YTDLP`。Node代码按平台运行，但本包的启动/安装脚本是Windows版本，附带的yt-dlp.exe也是Windows二进制；Linux/macOS需要自行准备相应平台依赖。不能直接把Windows配置路径复制过去。

工具参数与输出契约以MCP schema和MCP-GUIDE.md为准。分享包不含用户路径；配置片段中的绝对路径由接收方本机生成。

## 分发内容

包含代码、生产npm依赖、通用Skill、工具指南和第三方许可；排除测试依赖、本机客户端配置、个人ASR配置、实验视频/截图/转写、缓存、Git目录和旧验证记录。LICENSE、THIRD_PARTY.md和UPSTREAM.json保留原来源及PolyForm Noncommercial许可，不随新版上游许可自动改变。可选hook仅为样例，不自动启用。
