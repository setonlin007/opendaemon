# 🛠️ 后续优化项 / Future Improvements

记录第一版发布后想做但暂缓的事，按"优先级 + 工作量"排好。

---

## 🎙️ 音频 / 配音

### 1. 切换到火山引擎 TTS（剪映同款音色）⭐ 优先
**为什么**：剪映背后用的就是火山引擎，国内最自然的中文 TTS 之一，比 MiniMax 音色多 10 倍。

**怎么做**：
1. 去 https://www.volcengine.com 注册 + 实名 + 开通语音合成 TTS
2. 创建应用时勾选想用的音色（自带免费试用包）
3. 拿三个凭证：`AppID` / `Access Token` / `Cluster`
4. 跑脚本 `synthesize-audio-volcano.py`（待写）

**推荐音色（剪映对应名）**：
| voice_type | 剪映名 |
|---|---|
| `BV102_streaming` | 儒雅青年 |
| `BV142_streaming` | 沉稳解说男 |
| `BV411_streaming` | 小帅（解说小帅） |
| `BV437_streaming` | 小帅多情感 |
| `BV410_streaming` | 活力解说男 |
| `BV407_streaming` | 燃燃（科技播报） |
| `BV012_streaming` | 新闻男声 |
| `BV006_streaming` | 磁性男声 |
| `BV034_streaming` | 知性姐姐 |

**费用估算**：39 段共 1542 字，单次合成约 ¥0.006，免费试用 3 个月内足够。

### 2. 试听更多 Edge TTS 中文音色（0 成本）
当前用 `zh-CN-YunxiNeural`，还可以试：
- `zh-CN-YunyangNeural` 云扬 · 新闻播报式
- `zh-CN-YunjianNeural` 云健 · 体育解说节奏带感
- `zh-CN-YunfengNeural` 云枫 · 高级感播音
- `zh-CN-YunhaoNeural` 云皓 · 商务广告
- `zh-CN-liaoning-XiaobeiNeural` 晓北 · 东北话方言

完全免费，写个对比 page 30 分钟就能做。

---

## 📦 安装包 / 一键脚本

### 3. 加更多国内 AI 后端
当前 4 家（DeepSeek / 通义千问 / GLM / MiniMax）。可以加：
- **SiliconFlow** 硅基流动（聚合多模型）
- **Moonshot** 月之暗面 Kimi
- **豆包** 字节跳动
- **百川**
- **Anthropic 官方**（科学上网用户）
- **OpenAI / Gemini**（科学上网用户）

实现：脚本里加几条 case 分支。

### 4. Claude Code 版本检查 + 自动升级
当前只检测有无 `claude` 命令，不查版本。如果用户装的是半年前的 claude-code，可能跟新的 claude-code-router 不兼容。

实现：
```bash
INSTALLED_VER=$(npm list -g @anthropic-ai/claude-code --depth=0 | grep claude-code | sed -E 's/.*@([0-9.]+).*/\1/')
# 跟 npm view @anthropic-ai/claude-code version 对比
# 落后就提示 npm update -g
```

### 5. 失败回滚机制
现在脚本失败时 `exit 1`，但已经改了的 npm registry 不会还原。应该用 trap 捕获错误并恢复原 registry。

### 6. Gitee 镜像同步
当前只在 GitHub。Gitee 镜像可以让国内访问更稳：
1. 注册 Gitee
2. 用"从 GitHub 导入仓库"功能一键同步
3. 设置每天自动同步
4. 给评论用户提供 Gitee Raw URL 作备用

### 7. 对象存储分发（七牛云 / 阿里 OSS）
更稳的国内分发。但需要实名 + 备案，工作量大。当前 jsDelivr 已经够用。

### 8. CC-Switch GUI 集成（长期）
如果用户量起来，可以 fork [cc-switch](https://github.com/farion1231/cc-switch) 加自己的小白引导流程。需要 Apple Developer $99/年（Mac 签名）+ 可选 Win OV 证书 $200-300/年。

---

## 🎬 视频内容（系列规划）

### 9. 下集进阶玩法（已在 Ch7 预告）
4 个进阶武器：
1. **斜杠命令**：`/clear` / `/compact` / `/cost` / `/init` 等
2. **提示词技巧**：先探查 → 给具体路径 → 让它闭环
3. **子代理（Subagent）**：复杂任务并行
4. **MCP 工具集成**：接 Notion / GitHub / 数据库

每个可独立成集，也可合在一集。

### 10. 不同岗位的实操合集（系列）
基于 Ch3 use-cases 的 4 个岗位（程序员 / 运营 / 研究员 / PM），每个出一集深度操作演示：
- 运营版：清洗 Excel + 跨表统计 + 生成报表 demo
- 研究员版：读 PDF + 总结论文 + 整理引用
- PM 版：写文档 + 整理会议纪要 + 翻译
- 程序员版：重构 + debug + 写测试

---

## 📱 视频后期 / 平台分发

### 11. 9:16 竖屏版（抖音 / 小红书 / 视频号）
当前是 16:9 横屏。剪映里把横版居中 + 上下加字幕条 / 章节名 → 适配竖屏。

### 12. 30 秒短视频引流片段
- 短片 A · 焦虑钩子版（Ch1 + Ch3，~30s）
- 短片 B · 实操吸睛版（Ch5 examples，~30s）

### 13. 各平台标题 + 封面设计
- B 站 / YouTube 横版封面
- 小红书 / 抖音 / 视频号 竖版封面
- 每个平台不同标题套路

### 14. 字幕（视频里内嵌 CC）
当前视频是无字幕的，配音播放但屏幕上没字。
可以：
- 在剪映里导入音频 → 自动语音识别生成字幕
- 或者用我们 `narrations.ts` 直接生成 .srt 字幕文件，剪映里导入

---

## 🌐 视频网页本身

### 15. 用户反馈后微调动画时长
发布后看哪些 step 用户反映"太赶 / 太慢"，针对性调整。

### 16. 加 `?subtitle=1` 模式
在视频网页里直接显示当前 step 的 narration 文本（用 narrations[step]），方便不录屏直接当 demo 演示用。

### 17. 加错误统计 / 用户行为分析（不强求）
比如 `?lang=en` 模式做英文版（YouTube / 国外推广）。

---

## 优先级排序（如果一周只做 3 件事）

1. **【最高】** #1 火山引擎 TTS 切换（音色对发布质量影响最大）
2. **【高】** #11 + #12 + #13 视频后期 + 平台分发（直接决定流量）
3. **【中】** #3 加国内 AI 后端 + #4 版本检查（提升安装包鲁棒性）

其它都是锦上添花，发布后看数据反馈再排。
