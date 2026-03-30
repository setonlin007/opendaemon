# /tech-buzz — 技术热点聚合

搜集最热门的 AI / 技术讨论，聚合多个来源，生成带真实热度数据的结构化摘要。

## 参数

- `$ARGUMENTS` — 可选，指定关注的主题（默认 "AI agent, LLM"），也可传入具体关键词如 "RAG", "memory", "reasoning"

## 执行步骤

### Step 1: 结构化数据采集（并发）

使用 WebFetch 获取带真实热度指标的结构化数据：

1. **Hacker News Top Stories（必选）**
   - WebFetch `https://hacker-news.firebaseio.com/v0/topstories.json` → 获取前 15 个 story ID
   - 对每个 ID 并发 WebFetch `https://hacker-news.firebaseio.com/v0/item/{id}.json` → 获取 title, score, descendants(评论数), url
   - 筛选条件: score >= 50 且标题与 {topic} 相关（宽松匹配，技术/编程/AI 相关均可）

2. **GitHub Trending（必选）**
   - WebFetch `https://github.com/trending?since=daily` → 提取 repo 名、描述、语言、今日 stars
   - 筛选: 与 {topic} 或 AI/开发工具/编程 相关的项目

### Step 2: 搜索引擎补充（并发）

使用 WebSearch 补充 Step 1 无法覆盖的来源：

1. **Reddit**: `reddit MachineLearning LocalLLaMA {topic} 2026`（不用 site: 前缀）
2. **X/Twitter**: `site:x.com {topic} 2026`
3. **HuggingFace**: `site:huggingface.co {topic} 2026`
4. **综合技术媒体**: `{topic} latest news March 2026 release breakthrough`

其中 `{topic}` 用 `$ARGUMENTS` 替换，若为空则用 `AI agent LLM`。

### Step 3: 合并 & 排序

合并所有结果，按以下规则处理：

**热度标准化**（用于排序）：
- HN: score 直接使用（如 428 分）
- GitHub: today stars 直接使用（如 2,230 stars）
- Reddit: upvotes（如有）或根据搜索排名估算
- X/HuggingFace: 搜索排名靠前 = 高热度

**去重**：同一事件/项目在多个平台出现时合并为一条，标注所有来源。

**排序**：有量化热度的排前面，无量化的排后面。

### Step 4: 分类 & 格式化输出

将结果整理为以下分类（仅保留有实质内容的类别）：

- 🔬 **研究突破** — 新论文、新模型、新方法
- 🛠️ **工具/框架** — 开源项目、框架更新、新工具发布
- 💬 **行业讨论** — 观点碰撞、趋势判断、争议话题
- 🚀 **产品发布** — 新产品、重大功能更新

### Step 5: 保存归档

将结果保存到 `data/buzz/{YYYY-MM-DD}.md`，方便后续反思引擎使用。

## 输出格式

```markdown
# 🔥 Tech Buzz — {日期}

> 主题: {topic} | 来源: HN, Reddit, X, GitHub, HuggingFace

## 🔬 研究突破

1. **{标题}** `🔥 {热度数据}`
   {一句话摘要}
   📍 {来源} | [链接](url)
   💡 {为什么值得关注}

## 🛠️ 工具/框架
...

## 💬 行业讨论
...

## 🚀 产品发布
...

---
_共 {N} 条 | 采集时间: {timestamp}_
_来源状态: HN ✅/❌ | Reddit ✅/❌ | X ✅/❌ | GitHub ✅/❌ | HF ✅/❌ | 媒体 ✅/❌_
```

## 查询策略要点

- **HN 和 GitHub 用 API/WebFetch**：能拿到精确的 score/stars，是热度排序的锚点
- **Reddit 不要用 `site:` 前缀**：直接用 `reddit {subreddit} {topic}` 自然语言查询，命中率更高
- **X 可以保留 `site:x.com`**：效果稳定
- **HuggingFace 保留 `site:huggingface.co`**：效果稳定
- **所有 WebSearch 查询去掉布尔组合 (OR/AND)**：简单查询 > 复杂查询

## 注意事项

- 所有摘要用**中文**输出
- 优先展示**有实质技术内容**的讨论，过滤纯营销/广告
- 每个分类最多 5 条，总数不超过 20 条
- 如果某个来源搜索失败，跳过该来源继续执行，不要中断
- **必须展示真实热度数据**（HN score、GitHub stars、upvotes 等），不要编造
- 没有热度数据的条目标注"来自搜索引擎"即可，不要虚构数字
