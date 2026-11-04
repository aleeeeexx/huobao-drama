# 小说模块

织界旁边的独立服务。它不替换站内 `/novel`。建书执行私有 [AI_NovelGenerator](https://github.com/aleeeeexx/AI_NovelGenerator) main 快照里的默认任务 `create_novel_by_ai`：

1. 把创意扩成一整本的压缩故事
2. 提炼类型、基调、目标读者和核心设想
3. 生成核心种子
4. 生成书名、简介、世界观等设定

提示词和任务图在 `vendor/ai-novel-generator/`，字节来自私有 `aleeeeexx/AI_NovelGenerator` 的 main 快照，许可证是该快照携带的 GNU AGPL v3.0（见该目录 `LICENSE`）。上游完整程序还依赖 Python 3.13、MongoDB 副本集和 Next.js。这一版只把已经能单独跑通的建书图接进 Node，避免再起一套数据库和前端进程。

## 在织界里打开

顶栏「AI 建书」进入这个模块。它和「小说」不是同一页：「小说」仍是站内 `/novel`，按章写作并挂剧情图、剧情视频，设定和续写读取同一套提示词；「AI 建书」只跑上面的建书流程。

织界后端启动时会在本机拉起本服务（默认 `127.0.0.1:5681`）。页面放在织界同源的 `/ai-novel`，里面的界面经 `/ai-novel-app/` 转到本服务，不用自己记端口。已经有一个本服务在听这个端口时，后端会直接用它，不会再起一个。

桌面版打包会带上本目录，并由后端拉起。此时书库存到数据目录下的 `ai-novel/books.sqlite`，不写进安装包。Docker 镜像同样带上本目录，书库落在数据卷里。

先在织界设置页把文本模型配好并启用，再打开「AI 建书」，写下创意后点「生成故事方向」。

若顶栏里提示没有连上，在仓库根目录执行下面的命令，回到页面点重试：

```bash
cd ai-novel
npm start
```

需要 Node.js 22 或更新版本。服务只监听 `127.0.0.1`。单独打开 http://127.0.0.1:5681 仍然可以。本进程不替换 `/novel` 或 `/play`，只在同机读取织界那份 SQLite。设 `AI_NOVEL_AUTOSTART=0` 可关掉自动拉起。

生成请求默认使用织界当前文本模型的地址、密钥和模型名。选择规则与织界后端一致：`ai_service_configs` 中 `service_type = text`、已启用、provider 为 `openai` / `gemini` / `volcengine`、`priority` 最高的一条；同一优先级用 id 较小的那条。`model` 列是 JSON 数组，取第一项。每次建书现读，设置页改完保存后下一本就会用新配置。读取时加上 `query_only`，不改写织界库。

配置来源，优先级从高到低：

1. `AI_NOVEL_BASE_URL`、`AI_NOVEL_API_KEY`、`AI_NOVEL_MODEL` 三个都有值：按这套环境变量做 OpenAI chat completions，温度用 `0.7`。此时不读取织界库。地址以 `/chat/completions` 结尾则原样使用；以 `/v1` 结尾则补上 `/chat/completions`；否则补上 `/v1/chat/completions`。
2. 三个里只写了一部分：写了的字段覆盖织界配置，没写的字段用织界文本模型补上。请求协议仍按织界里的 provider。
3. 三个都没写：完全使用织界文本模型。

数据库位置与织界后端对齐：

| 条件 | 读取的文件 |
| --- | --- |
| 设置了 `SQLITE_PATH` | 该路径（桌面版主进程注入的就是这个） |
| 否则设置了 `HUOBAO_DATA_DIR` | `<HUOBAO_DATA_DIR>/huobao.sqlite3` |
| 否则 | 仓库根 `data/huobao.sqlite3`（`cd backend && npm run dev` 的默认库） |

桌面版的库不在仓库里。把 `SQLITE_PATH` 指到那份 `huobao.sqlite3`。打包版默认在用户数据目录的 `data/huobao.sqlite3`，例如 macOS 的 `~/Library/Application Support/HuobaoDrama/data/huobao.sqlite3`（桌面 dev 版目录名是 `HuobaoDrama-Dev`）。若在设置里改过数据目录，以 `storage-config.json` 里的 `dataDir` 为准。

织界 provider 为 `openai` 时走 chat completions；`volcengine` 走 `/api/v3/chat/completions`；`gemini` 走 `/v1beta/models/{model}:generateContent`，密钥放在 `x-goog-api-key`。这与织界文本调用使用的前缀一致。设置页里的温度会带上；没单独设温度时用 `0.7`。

显式改用另一套 OpenAI 兼容接口时：

```bash
export AI_NOVEL_BASE_URL="https://api.openai.com/v1"
export AI_NOVEL_API_KEY="你的密钥"
export AI_NOVEL_MODEL="gpt-4.1"
npm start
```

可选：

| 变量 | 作用 |
| --- | --- |
| `AI_NOVEL_PORT` | 端口，默认 `5681` |
| `AI_NOVEL_DB` | 本模块自己的书库，默认 `ai-novel/data/books.sqlite`，与织界库无关 |
| `AI_NOVEL_BASE_URL` / `AI_NOVEL_API_KEY` / `AI_NOVEL_MODEL` | 显式覆盖织界文本模型 |
| `SQLITE_PATH` / `HUOBAO_DATA_DIR` | 指定织界 SQLite 的位置 |

地址、密钥或模型名仍然对不上时，建书会失败，页面提示先在织界启用文本模型，或同时设置上面三个环境变量。

## 测试

```bash
cd ai-novel
npm test
```

测试用本地假模型走完整条建书接口，不访问外网。其中一组不设置 `AI_NOVEL_*`，用一份临时的织界库确认建书请求带上那条文本模型的地址、密钥和模型名。
