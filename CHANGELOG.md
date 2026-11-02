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
