# 来源与许可

Required Notice: Copyright 2026 SAOS-3624. Free for personal and non-commercial
use under the PolyForm Noncommercial License 1.0.0 (see LICENSE).
Commercial use requires a paid license — contact 1043740270@qq.com.

`vendor/dsh-see-now/` 的八个 JavaScript 文件源自 https://github.com/SAOS-3624/dsh-see-now ，提交 af33bbc750e267267a9cb2c35640c81f8ca1f2be。原始 NOTICE 一并保存；没有包含其 floating-chat 子项目。0.5.3 仅对 pipeline.js 增加可选渲染钩子及输出尺寸/布局元数据透传；原始哈希与该本地修改的哈希分别记录在 UPSTREAM.json 的 sha256 与 localModifications 中。其他七个文件保持原样。

本包增加 `src/` 的 stdio MCP、独立 worker、进度和持久化接口、CLI、测试及 Skill。没有修改 vendor 中的原始选帧算法。保持宽高比例、队列不丢图和结束 flush 属于外层适配。0.2.0 曾在外层增加 realtime 屏幕路径；0.7.0 已移除该能力，原 pipeline 与 DP 拼图仍用于文件和网络视频的自适应组图。历史来源文件与许可记录不因移除外层能力而改变。

0.5.3 的 `src/compact-sheet.mjs` 负责紧凑渲染和完整源帧缩放；原 DP 仍决定每批容纳的帧及输出时机，不再直接决定新拼图的格子尺寸。未配置渲染钩子时仍可使用原渲染器，便于对照验证。

MCP 使用官方 @modelcontextprotocol/sdk 1.32.2（MIT，v1 维护线），zod 版本由 package-lock.json 固定；node_modules 内保留每项依赖的 LICENSE/NOTICE。运行时使用本机 Node.js、FFmpeg 和 FFprobe，其二进制不包含在交付包中。

0.7.0 图片交付使用纯 JavaScript 依赖 [jpeg-js](https://github.com/eugeneware/jpeg-js) 0.4.4（BSD-3-Clause，Copyright 2014 Eugene Ware）与 [pngjs](https://github.com/pngjs/pngjs) 7.0.0（MIT，Copyright 2015 Luke Page & Original Contributors；derived work Copyright 2012 Kuba Niegowski）。0.8.0 运行时改用本机 FFmpeg 编码 JPEG；上述两个包仅作为开发/测试依赖，用于图片校验和对照，生产依赖包不要求携带它们。版本由 package-lock.json 固定；安装这些依赖时保留各自 node_modules 包的 LICENSE 文件，它们不因本工具包而改用 PolyForm 许可。JPEG交付与缓存属于外层适配，不修改原自适应选帧算法。FFmpeg 的具体许可和构建选项由接收方使用的安装版本决定，本包不分发其二进制。
# yt-dlp runtime added in 0.3.0

The Windows package bundles the official yt-dlp 2026.10.26 executable in `tools/yt-dlp.exe`, verified against its release SHA2-256SUMS. Exact source and hash are in `tools/yt-dlp-provenance.json`. Its own license and bundled third-party license notices are preserved as `tools/yt-dlp-LICENSE.txt` and `tools/yt-dlp-THIRD_PARTY_LICENSES.txt`. These components retain their own licenses; the original dsh-see-now license does not relicense them. No browser credentials are included.

## Optional ASR in 0.4.0

The adapter can call an independently installed [faster-whisper](https://github.com/SYSTRAN/faster-whisper) / CTranslate2 runtime and separately stored Whisper model. The verified local installation uses faster-whisper 1.2.1 and CTranslate2 4.8.3. Neither these Python dependencies nor model weights are bundled in this ZIP or Skill. They retain their own licenses and notices in their installation/model locations. No additional visual/language understanding model is invoked by the MCP.
