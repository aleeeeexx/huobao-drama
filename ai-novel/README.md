# 小说模块

织界旁边的独立服务。它不替换站内 `/novel`，也不走火宝小说提示词。建书执行 [AI_NovelGenerator](https://github.com/YILING0013/AI_NovelGenerator) `main` 上的默认任务 `create_novel_by_ai`：

1. 把创意扩成一整本的压缩故事
2. 提炼类型、基调、目标读者和核心设想
3. 生成核心种子
4. 生成书名、简介、世界观等设定

提示词和任务图在 `vendor/ai-novel-generator/`，来自提交 `a61674fad4dd6c4c5fa9a2ad2f12b667109e628a`，许可证是 GNU AGPL v3.0（见该目录 `LICENSE`）。上游完整程序还依赖 Python 3.13、MongoDB 副本集和 Next.js。这一版只把已经能单独跑通的建书图接进 Node，避免再起一套数据库和前端进程。

## 启动

需要 Node.js 22 或更新版本。在仓库根目录：

```bash
cd ai-novel
export AI_NOVEL_BASE_URL="https://api.openai.com/v1"
export AI_NOVEL_API_KEY="你的密钥"
export AI_NOVEL_MODEL="gpt-4.1"
npm start
```

浏览器打开 http://127.0.0.1:5681 。写下创意后点「生成故事方向」。页面会按上面四步出结果。服务只监听 `127.0.0.1`。

`AI_NOVEL_BASE_URL` 要兼容 OpenAI chat completions。地址以 `/v1` 结尾时会请求 `/v1/chat/completions`，否则自动补上 `/v1`。

可选：

| 变量 | 作用 |
| --- | --- |
| `AI_NOVEL_PORT` | 端口，默认 `5681` |
| `AI_NOVEL_DB` | SQLite 文件，默认 `ai-novel/data/books.sqlite` |

没有配齐地址、密钥和模型名时，建书会失败并在页面上说明。织界设置页里的文本模型不会被这里读取。

## 测试

```bash
cd ai-novel
npm test
```

测试用本地假模型走完整条建书接口，不访问外网。
