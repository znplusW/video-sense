# 媒体输入与同源文字输出

video-sense 0.9.0 接受本地视频、视频链接、本地音频或音频链接。画面、字幕、ASR 三类数据独立按需组合；需要画面才创建自适应组图任务，音视频均可只获取文字。MCP 只返回实际图片、原文、时间戳、来源、覆盖与状态；理解和回答由 Agent 完成。

外部字幕／转写文件不再导入 MCP。Agent 自行核对和使用用户给出的文字，需要画面时按可信的源时码请求图片。外部文本不参与自适应选帧；字幕和 ASR 也不是视觉处理的前置条件。

旧外部导入轨文件仍保留在磁盘，但新版不会通过文字读取或 video_evidence 将其作为同源文字返回；Agent 应直接使用原外部材料。新轨标记 origin=media_task，旧版具有生成缓存标识的同源轨继续可读取。升级后重新连接并刷新工具列表。

MCP 中字幕与 ASR 并列。Agent 可选择只字幕、只 ASR 或两者，MCP 不强制字幕优先，不因已有字幕排除 ASR，也不自动每次双跑。Skill 的默认取证顺序是先用可获取且来源可靠的字幕理解语言内容；字幕缺失、覆盖不足、不可靠，或任务需要核对时再使用 ASR 文本，也可保留双轨对照。这是宿主建议，不是 MCP 强制规则。两者都要时，分别建立轨道并显式传各自 trackId 读取；MCP 不合并原文或裁决可信度。

## 调用流程

1. 需要画面时用 `video_start` / `video_url_start`；只需文字时用 `audio_start` / `audio_url_start` 打开音视频文件或链接，无需创建图片任务。图片通过 `video_read` / `video_next` 等主动按批获取；video_url_start 默认只返回任务信息，显式 firstImage=true 才尝试返回首图。视觉与文字独立推进。
2. 选择字幕时，网络任务可用 `transcript_start(mode="subtitles")` 列出同一已解析媒体条目的可用字幕，选中返回的轨道 ID 后再次调用获取。无字幕返回 no_tracks，不能据此推定源媒体无声音。本地旁挂／嵌入字幕不由该模式自动读取。硬字幕属于画面像素，只能随选中的组图查看，不会提取成完整字幕文本，也不保证全文覆盖。
3. 选择 ASR 时（不论是否已有字幕），先检查 `video_doctor` 的可选后端，再 `transcript_start(mode="asr")`。源任务的 start/end 默认成为识别范围，也可指定合法源片段。不会因为打开音视频就自动运行 ASR。
4. 用 `transcript_read` 按源时间范围和事件游标分页读取。`nextAfter` 继续，`more` 描述当前查询是否还有现成事件；生成中的空页不是结束。若任务要求完整转写，应核对处理 complete、覆盖范围和分页尾部。只需部分证据的任务不强制读完其他文字。
5. `video_evidence` 返回同一视频任务中相交时间区间的图片和同源文字；纯音频直接用 `transcript_read`，不请求图片。图片与文字的时间相交只是机械关系，不证明语义或因果。
6. Agent 判断证据是否足以回答。`video_review` 只记录图片范围与确认，不接收必读文字轨、不追踪文字读完与否，也不把它作为 finish 条件。所需图量和文字范围由任务决定，不强制全图或 ASR。
7. 用户取消或所属处理收尾时使用 `session_stop`。停止保留已有数据，不删除文件，不把部分结果伪装成完整结果。

完整参数与结果语义以当前 MCP schema、`video_help` 和 [MCP 指南](MCP-GUIDE.md) 为准。MCP 可独立使用，不依赖 Skill。

## 来源、时间与状态

- 同源字幕来自当前解析条目；ASR 从当前任务音轨生成。来源关联不证明文字准确或音画同步，`binding.syncVerified:false` 应如实解释。
- 点播统一用原媒体秒数。图像时刻是采样网格估计，ASR 时码是后端估计；工具返回时间不是源媒体时间。
- 文本保留原文、来源、稳定段 ID、revision/final，以及来源实际提供的词时码。不补造说话者、置信度或逐句时间。
- 网络字幕只返回与请求范围相交的 cue，保留其原时码；cue 间空隙不是无语音证明。合法重叠段可以存在。
- 源 ready、音频采集 complete、转写 complete、文字分页读完是不同状态。ASR 只有在实际完成范围标记 speechStatus=no_speech 时，才说明该范围未识别到语音。
- 文字轨分别报告 requestedRange、processedRanges、status 和来源。视觉 overview 的空隙不会因转写齐全而消失。
- `transcript_start` 返回的文本轨 id 作为后续 trackId；工具参数 id 仍是媒体任务 id。事件 sequence、图片索引和时间秒数不能混用。

## 流式音频与回退

连续音频采集与 ASR 独立推进，以最多 64MiB 的 WAV 块缓存衔接；首块就绪即可识别，不等待完整下载。ASR 当前按块返回最终结果，不承诺逐词实时输出。

网络优先串流，有限恢复仍失败时才按 audioFallback 配置完整下载同一音轨，继续尚未完成范围；用户禁止完整下载时设为 never。模型错误、取消和本地写入错误不触发下载。audioTransfer 与 acquisition 分别记录传输路线和采集进度；判断转写范围仍看文本状态和 processedRanges。音视频复用容器的传输可能包含视频字节，不能保证只传音频数据。

## 可选 ASR 配置

当前提供 faster-whisper 适配器。默认读取各客户端 `AGENT_VIDEO_CONFIG_DIR` 目录中的 `asr.json`；未设置配置目录时使用 `XDG_CONFIG_HOME/video-sense/generic`，或 `~/.config/video-sense/generic`。默认文件不存在时报告 not_configured，视觉和可获取的同源网络字幕继续可用。`AGENT_VIDEO_ASR_CONFIG` 可显式指定其他 JSON 配置文件；显式路径不存在属于配置错误。0.8.0 不再读取共享工具包的 `config/asr.local.json`，客户端可使用各自配置，也可指向同一外置 ASR 配置、Python 环境与模型文件。`config/asr.example.json` 是配置示例，模型文件不包含在 Skill 或工具包中，也不会自动安装或下载。

ASR 由 MCP 调用配置的后端执行，不需要每个 Agent 重复安装。多个客户端可以把 AGENT_VIDEO_ASR_CONFIG 指向同一个外置共享 JSON，共用同一 Python 环境和模型文件；也可各用不同配置。各 MCP 进程仍可能分别加载模型，这不是共享的常驻 ASR 服务，内存占用不会因此自动合并。

```json
{
  "backend": "faster-whisper",
  "python": "C:/Path/To/Python/python.exe",
  "model": "C:/Path/To/faster-whisper-small",
  "device": "cpu",
  "computeType": "int8",
  "cpuThreads": 4,
  "beamSize": 5,
  "language": null,
  "wordTimestamps": true,
  "allowDownload": false,
  "idleSeconds": 120,
  "timeoutSeconds": 600
}
```

Python 需要安装 faster-whisper 及其 CTranslate2 等运行依赖。python 必须为绝对路径。model 可为本地模型目录或该适配器支持的标识，默认禁止联网下载；需要下载时须显式配置 allowDownload，可选 downloadRoot。此设置不会把模型写入 Skill。

device 支持 cpu、cuda、auto；实际设备能否运行取决于本机后端依赖。computeType 由 CTranslate2 支持情况决定。cpuThreads 为 1..32，beamSize 为 1..10，language 为语言代码或 null 自动检测，idleSeconds 为 5..600，timeoutSeconds 为 5..3600。配置改变会使用相应模型与参数，不静默回退到写死模型。

模型按需加载，相同配置复用持久后端；最多两个配置模型 worker，每个配置的调用串行执行，空闲后有界释放。后端返回真实句段和可选词级相对音频时码，由 MCP 调度映射回原媒体时间。当前后端增量输出最终段，不声称支持暂定段或后续修订；输出仍保留相应状态字段。

`video_doctor` 区分 not_configured、unavailable 与 ready_not_loaded，并报告引擎版本、模型、设备、时间戳能力和加载状态。ready_not_loaded 是环境检查结果，不等于已完成一次转写。modelRevision 的本地指纹基于相关模型文件大小与修改时间，不是权重内容的完整哈希。

## 能力边界

不启用屏幕采集、实时陪看、麦克风、系统声音录制或公网直播。仅提供已支持的 ASR 适配器；更换接口不同的引擎需要对应适配代码，不在本地失败时自动转发云端。

模型与依赖由接收方准备一次即可供多个 Agent 共用。环境检查不等于已运行转写，也不代表识别质量；语言、模型、音质和硬件均影响结果。
