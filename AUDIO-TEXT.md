# 0.5.2 视频与纯音频证据

`video-sense` 支持自适应视频选帧和独立纯音频，并接入字幕、外部转写和可选 ASR。纯音频入口为 audio_start / audio_url_start / audio_status，完整调用与状态含义以 MCP-GUIDE.md 第 10 节和工具 schema 为准。MCP 提供实际图片、源文本、时间映射与处理状态；图片和语言的语义理解由 Agent 完成。它不生成画面描述、事件标签、摘要、操作结果或因果结论。

视觉任务仍可独立使用。模型权重和 ASR 依赖不属于 Skill，不随普通视频看图任务加载。字幕可用时无需重新识别；外部工具生成转写后也可直接导入。

## 工具流程

1. 视频用 `video_start` 或 `video_url_start` 建立视觉任务，总结/解读默认 continuous 处理完整请求范围；明确片段按片段，明确速览才用 overview。纯音频直接用 `audio_start` 或 `audio_url_start`，等 `audio_status` 源就绪，不建视频任务、不请求图片。视频图片通过 `video_read` 批量或 `video_next` 逐张读取，逐张查看拼图各格，图片与文字并行推进。
2. 用户提供字幕/转写文件时，用 `transcript_import` 绑定该任务与媒体。源文件为本地 SRT、VTT 或规范 JSON；显式记录来源和偏移。
3. 网络字幕或可选 ASR 使用 `transcript_start`，以同一任务身份取得相同媒体条目和范围。用户指定重新转写或后端时，尊重该选择。
4. 用 `transcript_read` 分页/按时间段读文字，沿 nextAfter 读到处理 complete 且分页已尽。仅视频任务可用 `video_evidence` 取同一时间区间的图片与文字，且须真正查看 image 内容；它不替代读完原请求范围的全部图片。纯音频无需图片。
5. 视频最终回答前须视觉成功完成且覆盖请求范围、实际看完全部生成图片，以及所需文字已完成并读尽分页。visualDelivery 用于查漏图，仅证明图片交付，不证明模型理解。ASR complete 或当前空页都不能让正常视频提前停止。音频源 ready 不代表转写完成；用户明确只要音频/ASR 可跳图，纯视觉不强制 ASR。证据读完后收尾；用户取消或无法继续时用 `session_stop`，如实说明缺失范围。

MCP 可脱离 Skill 独立使用，完整接口、调用与分页说明通过 `video_help` 返回，源文档为 [MCP-GUIDE.md](MCP-GUIDE.md)。具体参数以服务当前工具 schema 为准。已有客户端进程不会因文件更新自动重载；重连后用 `video_doctor` 确认版本及实际后端能力，不以 package.json 版本代替运行态核验。

0.5.1 起，连续音频采集与 ASR 独立推进，由最多 64MiB 的 WAV 块缓存连接。首块即可识别；采集不会因识别等待而主动暂停。acquisition 的解码/缓存状态与文字处理状态分别报告，只有文本 complete 及其 processedRanges 才能用于判断转写完整。

网络音频以串流为默认，先有限重连/一次源级重试，仍获取失败才可完整下载同源音轨后从未完成处继续识别。audioFallback=never 可关闭下载回退；取消、模型/权限/容量等错误不会触发下载。audioTransfer 记录实际处理路径，接口与完整限额以 MCP-GUIDE.md 第 12 节为准。

## 数据和时间约定

- 点播图片/文本以原媒体秒数查询。图片时间沿用采样网格估算，不能称作精确原始 PTS。
- 文本段至少携带稳定 ID、start/end、原文字和来源类型。字幕来源不伪装成 ASR；未知语言、人工/自动状态或同步状态不猜测。
- 导入保留原始时码和显式偏移。解析成功只是格式成立，绑定依据和同步核验是独立信息。
- 合法字幕重叠可以保留。一段文字可关联多帧，一帧也可落入多段文字；关联仅是时间关系。
- 未对齐全文不进入伪造的逐句时间轴。ASR 结果按真实能力保留句段或词级时间、源内说话者标记和质量字段。
- 暂定结果与最终结果通过 final 标记区分；修订沿稳定片段 ID 追踪，不重复计为新事件。
- 视觉和文本分别报告状态与处理范围。overview 的未取样空隙保持存在，不能借全片转写宣称视觉覆盖完整。

## 外部转写 JSON 契约

SRT/VTT 导入识别为字幕；JSON 可声明 `source.type` 为 `subtitle`、`external_transcript` 或 `asr`。`asr` 仅用于真实 ASR 来源，来源与模型信息应如实提供。JSON 中的媒体标识若存在，必须与绑定任务的媒体标识一致。调用导入工具时，媒体标识和绑定依据不能省略或靠相似标题猜测。

下面是截取片段的外部转写示例。将 `MEDIA_ID_FROM_VIDEO_STATUS` 替换为目标任务返回的实际媒体标识，导入时明确设置 `offsetSeconds:600`；它把本例的 0.2–2.4 秒映射为原视频 600.2–602.4 秒，保留原始时码。

```json
{
  "schemaVersion": "1",
  "mediaId": "MEDIA_ID_FROM_VIDEO_STATUS",
  "timeBase": "clip_relative_seconds",
  "timeUnit": "seconds",
  "source": {
    "type": "external_transcript",
    "language": "zh",
    "timestampAccuracy": "unknown"
  },
  "segments": [
    {"id": "s1", "start": 0.2, "end": 2.4, "text": "点击保存按钮", "final": true, "revision": 0}
  ]
}
```

`timeBase` 接受 `source_media_seconds`、`clip_relative_seconds`、`chunk_relative_seconds`；输出统一为原媒体秒数。偏移只按 `mapped_seconds = input_seconds + offsetSeconds` 换算，不自动估计，也不修复剪辑差异或持续漂移。`alignment:"aligned"` 仅表示文本具有可映射时码，`binding.syncVerified:false` 仍表示未核验音画同步。

每段 `start/end` 是有限数值秒，必须有正持续时间；偏移后不得小于 0 或超出已知媒体时长。`text` 必须为非空字符串，原文字保留，不默认改写。合法段重叠不删除、不合并。可选 `words` 为 `{start,end,text,quality?}` 数组，词时码需位于所属句段内。

可选源字段包括 language、trackId、subtitleKind、backend、model、engineVersion、device、provider、timestampAccuracy、quality。subtitleKind 为 manual、automatic、translated 或 unknown。段内可选 speaker 和 quality 仅保留来源实际提供的值；不同后端的 quality 不具有统一准确率含义。

缺少段 ID 时按媒体、轨道、格式和原始顺序生成稳定 ID。外部系统需要传入修订时，应自行保留相同 ID，并增加 `revision`。`final` 默认 true、revision 默认 0；同 ID 的旧修订忽略，同修订改变内容会拒绝，最终结果不能回退为暂定。相同文字在重叠时段不自动视作分块重复。

无时码全文可以使用 `{"text":"只有全文，没有逐句时间"}`，输出保留 `unalignedText` 与 unaligned 状态，不生成逐句时码。JSON 声明的 schemaVersion 只支持 1，timeUnit 只支持 seconds。导入上限为 10 MiB、100000 段、500000 词时码。时间查询使用半开区间 `[start,end)`，合法重叠段分别返回。

MCP 的 `transcript_read` 是事件流，after 表示已读事件 sequence、初始 0，nextAfter 继续；同 ID 的新 revision 替换旧理解。`video_evidence` 的 afterSheet/nextSheet 是图片扫描偏移。证据中每轨返回的是有界文本快照；更多文字用 transcript_read 从相应事件游标读取，不把文本快照 offset、事件 sequence 和图片 index 混用。import/start 返回的 id 是文本轨 UUID，读取时仍用视觉任务 id，加此 UUID 作为 trackId。

## 可选 ASR 配置

当前提供 faster-whisper 适配器。默认读取各客户端 `AGENT_VIDEO_CONFIG_DIR` 目录中的 `asr.json`；未设置配置目录时使用 `XDG_CONFIG_HOME/video-sense/generic`，或 `~/.config/video-sense/generic`。默认文件不存在时报告 not_configured，视觉和外部文本导入继续可用。`AGENT_VIDEO_ASR_CONFIG` 可显式指定其他 JSON 配置文件；显式路径不存在属于配置错误。0.8.0 不再读取共享工具包的 `config/asr.local.json`，不同客户端分别维护自己的配置、Python 环境与模型路径。`config/asr.example.json` 是配置示例，模型文件不包含在 Skill 或工具包中，也不会自动安装或下载。

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

模型按需加载，相同配置复用持久后端；最多两个配置模型 worker，每个配置的调用串行执行，空闲后有界释放。后端返回真实句段和可选词级相对音频时码，由 MCP 调度映射回原媒体时间。当前后端增量输出最终段，不声称支持暂定段或后续修订；外部 JSON 契约可以表示这些状态。

`video_doctor` 区分 not_configured、unavailable 与 ready_not_loaded，并报告引擎版本、模型、设备、时间戳能力和加载状态。ready_not_loaded 是环境检查结果，不等于已完成一次转写。modelRevision 的本地指纹基于相关模型文件大小与修改时间，不是权重内容的完整哈希。

## 输入与后端范围

只按任务需要获取现有视频音轨；本版流程不启用麦克风、Windows 系统音频录制或新的公网直播输入。原有已授权屏幕陪看仍是画面采集流程。

ASR 接口用于已支持的可替换适配器。不同引擎接口需要对应适配代码；云服务是扩展方向，不在本地失败时自动启用。仅有字幕/外部 JSON 的用户不需要模型下载。音视频复用流可能仍需传输视频容器数据，不能承诺与独立音轨相同的节流效果。

ASR 需要接收方独立安装 Python、faster-whisper 和本地模型，并在客户端配置目录指定路径。依赖可用性检查不代表实际转写质量；语言、模型和硬件均会影响准确率与耗时。
