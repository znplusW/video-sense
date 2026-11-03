# 动态视听 · video-sense

[English](README.en.md) | 简体中文

**为 Agent 提供可查看、可追溯的视频与音频证据。**

video-sense 是面向 Windows 的本地 MCP 服务与可选通用 Skill。输入视频或音频，按需选择自适应画面、同源字幕、ASR 原文及其组合，并返回时间戳与处理状态，让 Agent 根据你的问题完成理解与回答。

当前版本 **0.9.0**。支持标准 stdio MCP；Codex、WorkBuddy 是接入示例，不是运行依赖。当前安装脚本和分发包适配 Windows，尚不宣称 macOS/Linux 安装体验已验证。

## 能做什么

- **看视频**：本地文件、HTTP(S) 直链以及 yt-dlp 支持的点播页面；支持指定片段、连续分析、速览与定点补看。
- **听音频**：独立音频任务，无需创建视频任务。可获取同源网络字幕，或使用可选的本地 faster-whisper ASR。
- **边处理边取证**：网络优先串流；有限恢复仍失败时，可回退下载对应完整媒体轨再本地分析。
- **减少图像传输开销**：默认 JPEG，每批最多 12 张组图、8MiB 编码图片；保留 PNG 原图供小字、数字与图表复核。一张组图可以包含多个帧，12 张不等于 12 帧。
- **多 Agent 共用源码**：一份运行代码、一份通用 Skill，各客户端拥有独立配置、数据和进程。

画面、字幕与 ASR 都是可选数据。只需文字时，即使源是视频，也可用 audio_start / audio_url_start 打开源，不创建图片任务；需要画面才使用 video_start / video_url_start。网络视频启动默认只返回任务信息，显式 firstImage=true 才尝试附带首图，其余图片由 Agent 主动按需读取。

## 它如何“看”视频

连续分析由一个 FFmpeg 进程持续解码，依据颜色与运动变化自适应选帧，再组成带时间信息的图片。Agent 根据问题和字幕／ASR 的信息缺口选择部分或全部组图，需要时补看具体时间点。

MCP **不生成画面描述、摘要、事件标签或因果判断**，只提供实际图片和原始文字等证据。语义理解由宿主 Agent 完成。图片生成、工具交付、模型查看是不同状态；阅读协议记录查看范围，但不能证明理解正确。

MCP 只接受媒体输入，不接收外部字幕／转写。用户另行提供的文字由 Agent 核对来源后直接使用，需要画面时按已确认的时码请求；MCP 不用文字驱动选帧，也不检查 Agent 是否读完文字。文字处理状态、覆盖范围和分页仍然保留，充分性由 Agent 根据任务判断。

这不是逐原始帧分析，也不保证捕捉每个短暂变化。更精细的短时间高频抽帧通常更耗时，需另用其他工具。本项目不提供屏幕采集、实时陪看、麦克风或系统声音采集。

## Windows 快速安装

### 1. 准备环境

- Node.js **20 或更高版本**。
- FFmpeg 和 FFprobe，加入 PATH 或显式指定路径。
- 支持 stdio MCP 的 Agent 客户端；查看视频画面还需要客户端能向视觉模型传递 MCP 图片。
- ASR 可选：Python、faster-whisper 和模型需另行准备；纯视觉和同源网络字幕获取不依赖 ASR。

从仓库 Releases 获取便携 ZIP，解压至固定共享目录，例如 `D:\AgentTools\video-sense`。便携包包含生产 npm 依赖及 Windows yt-dlp，不包含 Node、FFmpeg、Python 或 ASR 模型。

从源码安装则先在仓库目录执行 `npm ci --omit=dev`，再继续以下步骤。

### 2. 生成每个客户端的配置

在解压目录打开 PowerShell：

```powershell
.\install.ps1 -ConfigDir 'D:\AgentA\config\video-sense'
.\configure.ps1 -ConfigDir 'D:\AgentB\config\video-sense'
```

脚本生成 `mcp.json` 配置片段，**不会自动修改宿主主配置**。将其中的 `video-sense` 条目合并进各客户端的 MCP 配置，然后重连或重启客户端。两个配置指向同一个 `src/bootstrap.mjs`，但数据目录分别独立。

也可以生成特定客户端格式：

```powershell
.\configure.ps1 -Client codex
.\configure.ps1 -Client workbuddy
```

分别写入用户目录下 `.codex/video-sense/mcp.toml` 与 `.workbuddy/video-sense/mcp.json`，仍需合并到宿主主配置。依赖不在 PATH 时可传入 `-NodePath`、`-FfmpegPath`、`-FfprobePath`。完整选项及通用手工配置见 [Windows 安装指南](PORTABLE-README.md)。

### 3. 检查连接

让 Agent 调用 `video_doctor`，检查版本和依赖，再调用 `video_help` 获取当前工具流程。ASR 显示未配置时，仍可使用视频画面和可获取的同源网络字幕。

### 4. 可选：接入通用 Skill

MCP 无需 Skill 即可独立使用。Skill 只辅助能力发现及取证选择，不包含特定模型、宿主 hook 或本机路径依赖。

```powershell
.\install.ps1 -ConfigDir 'D:\AgentA\config\video-sense' -SkillDir 'D:\SharedSkills\video-sense'
```

让各 Agent 发现这一个共享 Skill 目录即可。支持 Windows 目录联接的客户端可以通过 `mklink /J` 引用它；宿主技能目录位置以各客户端设置为准。共享 Skill 不会自动注册 MCP。

## 使用示例

连接后直接对 Agent 说：

> 总结这个视频，结合画面解释演示步骤：D:\Videos\demo.mp4
>
> 分析这个视频链接，重点看 02:00–04:00 的图表，并指出文字没解释的变化。
>
> 转写这个音频文件，只处理前 3 分钟，并保留时间戳。

MCP 中字幕与 ASR 是并列来源，Agent 可选择只字幕、只 ASR 或两者；有字幕也可启动 ASR，不自动每次双跑。两者都取时分别建立轨道、指定 trackId 读取，保留来源，不由 MCP 合并或裁决可信度。Skill 的默认取证顺序是先用可获取且来源可靠的字幕理解语言内容；字幕缺失、覆盖不足、不可靠，或任务需要核对时再使用 ASR 文本，也可保留双轨对照。这是宿主建议，不是 MCP 强制规则。 画面按任务可只读部分组图，也可请求需要加强查看的时间段或定点数据；不强制全图。

## 可选 ASR 与数据

将 `config/asr.example.json` 中的配置按本机环境填写，保存为客户端 `ConfigDir/asr.json`；也可用 `-AsrConfig` 指定外置文件。多个 Agent 可引用同一份 ASR JSON，共用一次安装的 Python 环境和模型，无需逐个重复安装；各 MCP 进程仍可能分别加载模型，并非共享常驻 ASR 服务。模型不会自动下载。详细说明见 [音频与文字](AUDIO-TEXT.md)。

任务数据默认保存到客户端配置目录下的 `data`，可用 `-DataDir` 修改。网络解析会访问源站；MCP 不自行调用云端理解模型，但返回的证据会进入宿主 Agent，其数据处理方式取决于宿主配置。不要把 Cookie、私有配置、媒体缓存或转写结果提交到公开仓库。

## 限制与排错

- 字幕获取支持网络源提供的字幕；不自动提取本地嵌入字幕或读取旁挂字幕。硬字幕只能随选中画面查看，不自动转为完整文字，也不保证全文覆盖。
- 不保证所有网站、登录内容、DRM 或直播可解析；遵守来源访问权限.
- 图片不足以回答时应补看或说明缺口；ASR 可能识别错误，时间重叠不能证明语义关联。
- 修改 MCP 运行代码或配置后，需要重连／重启客户端。
- 运行 `video_doctor` 检查 Node、FFmpeg、FFprobe、解析器及 ASR；工具参数与返回契约以当前 MCP schema 和 `video_help` 为准。
- JPEG 编码采用有界 FFmpeg 队列，具备超时与取消管理；不承诺固定速度提升。

## 文档与开发

- [English introduction and Windows setup](README.en.md)
- [Windows 完整安装指南](PORTABLE-README.md)
- [MCP 接口及工作流](MCP-GUIDE.md)
- [字幕、转写及 ASR](AUDIO-TEXT.md)
- [通用 Skill](skills/video-sense/SKILL.md)

开发环境执行 `npm ci` 安装测试依赖；测试需可用的 FFmpeg/FFprobe。`npm test` 运行测试套件，真实 ASR 部分需额外环境条件。Windows 安装流程已做针对性检查，详见 [版本说明](CHANGELOG.md)。

## 来源与许可

基于 [SAOS-3624/dsh-see-now](https://github.com/SAOS-3624/dsh-see-now) 的自适应选帧与拼图核心，固定来源及修改记录见 [UPSTREAM.json](UPSTREAM.json)。本项目增加独立 MCP、音频和文本流程、图像交付、通用 Skill 与共享安装支持。

**采用 PolyForm Noncommercial 1.0.0，非 GPLv3。** 请按 [LICENSE](LICENSE) 和 [第三方声明](THIRD_PARTY.md) 使用；这不是允许任意商业用途的许可。第三方组件保留各自许可，上游商业授权要求见第三方声明。
