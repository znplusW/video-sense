# 0.9.0

## 简体中文

- 输入收敛为视频／音频文件与链接，输出画面、同源网络字幕及可选 ASR 原文。
- 移除外部字幕／转写导入接口；外部文字由 Agent 核对来源后直接使用，按已确认时码请求图片。
- 移除必读文字轨及文字分页完成门槛。保留处理状态、覆盖范围、分页和同源证据时间查询；图片阅读协议继续工作。
- 同步 MCP 独立说明、通用 Skill 及中英文产品文档。不强制全图或 ASR，取证充分性由宿主判断。
- 画面生成也可选；只取文字可通过 audio 入口打开视频源。video_url_start 默认只返回任务信息，新增 firstImage=true 可主动请求首图。
- 字幕与 ASR 并列，支持按任务只取其中一种或两者分别输出，不自动合并或裁决。
- 已有外部导入轨文件保留，但不再通过文字读取或时间段证据返回为同源文字；旧版同源生成轨仍可读取。

这是接口不兼容更新：旧调用方应刷新工具列表并停止调用导入接口或传入文字阅读计划参数。重新连接 MCP 后使用 video_help 查看当前流程。

## English

- Media-only inputs: local/network video or audio; outputs remain images, same-source network subtitles and optional ASR text.
- Removed external subtitle/transcript import. The host verifies and uses external text directly, requesting images at verified media timestamps.
- Removed required-text-track and text-pagination completion gates. Processing status, coverage, pagination and same-source time-based evidence remain available; image receipts remain in place.
- Updated standalone MCP guidance, generic Skill and bilingual documentation. No mandatory all-images or ASR policy; the host judges evidence sufficiency.
- Visual production is optional too: audio entry points can open video sources for text only. video_url_start now returns task information by default; firstImage=true explicitly requests an initial image.
- Subtitles and ASR are peer sources, selectable separately or together as distinct tracks without automatic merging or credibility ranking.
- Existing imported-track files are retained but no longer returned as same-source text through transcript reads or interval evidence. Legacy same-source generated tracks remain readable.

This is a breaking interface change. Refresh tool discovery, stop calling the import tool or passing text-review plan parameters, and reconnect the MCP. See video_help for current workflows.

# 0.8.0

## 简体中文

- FFmpeg JPEG 交付：并发、队列、执行超时、取消与输出大小均设边界。
- 保留默认 12 张组图上限、PNG 原件及缓存重放校验；统一单图和批量字节预算。
- 多客户端共用源码，配置／ASR／数据外置；通用 Skill 不依赖宿主专用设置。
- 修复通过 Windows 目录联接启动时入口误判退出的问题。
- 包含此前 0.7.0 的屏幕能力移除；不提供实时陪看。

验证范围：本地媒体与 MCP 图像返回、字幕导入／关联、缓存重放、取消／预算、编码队列、配置隔离和 Junction 启动的针对性测试通过。便携包验证实际 JPEG/PNG 返回；未重跑长视频性能对比或真实模型转写，不将依赖检查当作 ASR 质量测试。

## English

- Managed FFmpeg JPEG delivery with bounded concurrency, queues, execution time, cancellation and output size.
- Retained the 12-storyboard limit, original PNGs and verified cache replay; enforced image budgets consistently for single and batch responses.
- Shared runtime source with client-owned configuration, ASR settings and data; host-neutral Skill.
- Fixed entry-point detection when launching through a Windows directory junction.
- Includes the removal of screen capture from 0.7.0; live viewing companionship is not provided.

Validation covered local media/MCP images, subtitle imports and associations, replay, cancellation/budgets, encoder queues, configuration isolation and junction startup. The portable package returned actual JPEG/PNG images. Long-video benchmarks and real-model transcription were not rerun; dependency checks do not establish transcription quality.
