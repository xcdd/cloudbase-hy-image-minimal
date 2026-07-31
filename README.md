# CloudBase AI 图片与对话服务

这是一个可以直接在本地运行或作为单个 Cloud Run 服务部署的最小项目，同时提供：

- 图片模型 `HY-Image-3.0-Plus-4090-Tob-v1.0`
- 文字模型 `hy3`、`hy3-preview`
- OpenAI 兼容的非流式与 SSE 流式对话接口
- 用于管理业务访问密钥的 Web 控制台

它适合下面这种场景：

- 你已经有 `ENV_ID`
- 本地 CLI 调用时，你已经有 `CLOUDBASE_APIKEY`
- 你想最快跑通一条“输入提示词 -> 返回图片链接”的生图流程
- 你希望在同一个服务内提供图片生成和 AI 对话，不额外运行第二套服务

## 这个项目帮你做了什么

这个项目已经默认处理好了这些事情：

- 默认使用模型 `HY-Image-3.0-Plus-4090-Tob-v1.0`
- 默认使用 `1024x1024` 尺寸
- 默认给 `footnote` 传一个单空格，让右下角标识尽量缩到最小
- 提供 `/v1/chat/completions` 和原 CloudBase 风格的兼容路径
- 使用 `hunyuan-v3` Node SDK provider 从 CloudBase 服务端调用成长计划文字模型
- 图片和文字接口共用同一个进程、CloudBase SDK 实例及部署资源
- 访问密钥在本地持久化到摘要文件，生产环境可持久化到 CloudBase 数据库集合 `ai_service_keys`

本地直接生图时使用：

- `direct-generate.js`

部署统一服务时直接使用仓库根目录的 `Dockerfile`。

## 先准备什么

在开始之前，你需要准备好：

1. 电脑里已经安装 `Node.js`
2. 你自己的 CloudBase 环境 ID
3. 本地直接运行 CLI 时需要 CloudBase API Key
4. HTTP 服务可以先启动，再从 Web 后台保存 CloudBase 凭据

本地 CLI 使用：

- `ENV_ID`
- `CLOUDBASE_APIKEY`

生产部署建议设置：

- `ENV_ID` 或 `TCB_ENV_ID`
- `SERVICE_API_KEY`
- `ADMIN_PASSWORD`
- `ADMIN_SESSION_SECRET`

`ENV_ID` 和 `CLOUDBASE_APIKEY` 既可以通过环境变量预设，也可以在服务启动后从 Web 后台保存。

## 第一次使用

先进入项目目录：

```bash
cd cloudbase-hy-image-minimal
```

然后安装依赖：

```bash
npm install
```

这一步通常只需要做一次。

## 启动统一 HTTP 服务

统一服务同时提供图片生成和文字对话。无需预先配置环境变量即可启动：

```bash
npm start
```

未设置管理员密码时，启动日志会生成本次运行使用的随机密码。未设置接口密钥且本地密钥文件为空时，会生成第一把业务密钥；该密钥在后续重启中保持不变。打开后台后填写：

- `ENV_ID`：CloudBase 环境 ID
- `CLOUDBASE_APIKEY`：CloudBase 上游调用凭据

后台只返回和显示脱敏后的凭据，原文保存在权限为 `0600` 的 `.cloudbase-credentials.json` 中，并且不会提交到 Git。保存后 AI 接口立即使用新凭据，无需重启。

本地业务访问密钥保存在权限为 `0600` 的 `.service-keys.json` 中，文件只包含密钥摘要和脱敏前缀，不包含明文。首次启动会生成一把密钥并只显示一次；后续重启会复用原有密钥，不会再次随机更换。后台对密钥的编辑、轮换和删除会立即写入该文件。

生产环境还应设置：

- `SERVICE_API_KEY`：首次启动时写入后台的初始业务访问密钥
- `ADMIN_PASSWORD`：Web 管理后台密码，至少 12 个字符
- `ADMIN_SESSION_SECRET`：管理会话签名密钥，至少 32 个字符

`SERVICE_API_KEY` 只用于保护这个 HTTP 服务，不要直接复用或暴露 CloudBase API Key。

Linux / macOS：

```bash
export ENV_ID=你的环境ID
export CLOUDBASE_APIKEY=你的CloudBase凭据
export SERVICE_API_KEY=一段足够长的随机密钥
export ADMIN_PASSWORD=至少十二个字符的管理员密码
export ADMIN_SESSION_SECRET=至少三十二个字符的随机签名密钥
npm start
```

PowerShell：

```powershell
$env:ENV_ID="你的环境ID"
$env:CLOUDBASE_APIKEY="你的CloudBase凭据"
$env:SERVICE_API_KEY="一段足够长的随机密钥"
$env:ADMIN_PASSWORD="至少十二个字符的管理员密码"
$env:ADMIN_SESSION_SECRET="至少三十二个字符的随机签名密钥"
npm start
```

直接运行 `npm start` 且未设置 `PORT` 时，服务默认监听
`http://localhost:8080`。通过 systemd 运行的本机实例会读取
`.service.env`，当前监听 `http://localhost:52557`。

调用前建议按实际部署地址设置基础 URL。本机 systemd 实例使用：

```bash
export BASE_URL=http://localhost:52557
```

直接使用默认配置运行 `npm start` 时则使用：

```bash
export BASE_URL=http://localhost:8080
```

健康检查地址为：

```text
GET /healthz
```

例如：

```bash
curl "$BASE_URL/healthz"
```

### Web 管理后台

本机 systemd 实例在浏览器中打开：

```text
http://localhost:52557/
```

后台首先用于保存和查看脱敏后的 CloudBase 上游凭据，同时支持新建、编辑、启停、轮换和删除业务访问密钥。业务访问密钥只保存 SHA-256 摘要，创建或轮换后的明文仅返回一次。

### OpenAI 兼容对话

模型列表及单个模型信息：

```text
GET /v1/models
GET /v1/models/{model}
```

以下两个路径功能相同：

```text
POST /v1/chat/completions
POST /v1/ai/cloudbase/chat/completions
```

非流式示例：

```bash
curl "$BASE_URL/v1/chat/completions" \
  -H 'Authorization: Bearer 你的SERVICE_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "model": "hy3",
    "messages": [{"role": "user", "content": "你好"}],
    "stream": false
  }'
```

流式示例：

```bash
curl -N "$BASE_URL/v1/chat/completions" \
  -H 'Authorization: Bearer 你的SERVICE_API_KEY' \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -d '{
    "model": "hy3-preview",
    "messages": [{"role": "user", "content": "介绍一下你自己"}],
    "stream": true
  }'
```

现有 OpenAI 客户端通常只需配置：

```text
baseURL = https://你的服务域名/v1
apiKey = SERVICE_API_KEY
```

`hy3` 和 `hy3-preview` 默认会补充：

```json
{
  "enable_thinking": true,
  "reasoning_effort": "high"
}
```

响应中的 `reasoning_content` 和 `completion_tokens_details.reasoning_tokens` 会原样返回。客户端可以显式传 `enable_thinking: false` 关闭。服务也会识别常见客户端的关闭格式，包括 `reasoning_effort: "none"`、`thinking: {"type": "disabled"}` 和 `reasoning: {"effort": "none"}`，并统一转换成上游实际支持的 `enable_thinking: false`。

服务会提前初始化 CloudBase AI SDK，并在凭据不变时复用底层文字及图片模型实例，减少本地首请求开销。CloudBase 模型侧的排队和冷启动时间无法由本服务消除；默认不使用周期性生成请求保温，以免持续消耗额度并触发 429 限流。

腾讯网关偶尔会在冷启动或内部路由切换时只返回一个没有具体错误码的 HTTP 429。服务会对此类模糊 429 短暂等待后重试一次；明确的并发上限、速率上限或额度错误不会重试，并会原样返回给调用端。

工具调用支持标准 `tools` / `tool_choice`，同时兼容旧版 `functions` / `function_call`。服务返回模型生成的 `tool_calls`，具体工具仍由调用端执行，再把 `role: "tool"` 的结果消息发回对话接口。

对于部分开发工具使用的非标准内置搜索声明，服务也会自动转换为 OpenAI 函数工具：

```json
{"type": "web_search_preview"}
```

或：

```json
{
  "type": "builtin_function",
  "name": "builtin_web_search",
  "input_schema": {
    "type": "object",
    "properties": {"query": {"type": "string"}},
    "required": ["query"]
  }
}
```

如果上游模型仍输出 `<tool_calls>` 文本，服务会在非流式和 SSE 流式响应中将其还原成结构化 `tool_calls`，并保留 `reasoning_content`。

### 同一服务内生成图片

```bash
curl "$BASE_URL/v1/images/generations" \
  -H 'Authorization: Bearer 你的SERVICE_API_KEY' \
  -H 'Content-Type: application/json' \
  -d '{
    "prompt": "一只橘猫坐在窗边看雨",
    "size": "1024x1024"
  }'
```

## 部署为单个 Cloud Run 服务

仓库根目录已经包含 `Dockerfile`。在 CloudBase 控制台创建或更新现有 Cloud Run 服务时，直接部署整个仓库根目录，并设置：

```text
ENV_ID=你的环境ID
SERVICE_API_KEY=你自己的服务访问密钥
ADMIN_PASSWORD=至少十二个字符的管理员密码
ADMIN_SESSION_SECRET=至少三十二个字符的随机签名密钥
AI_PROVIDER=hunyuan-v3
```

部署后同一个实例同时处理管理后台、图片生成和文字对话。

可选配置：

| 环境变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `8080` | HTTP 监听端口，Cloud Run 通常会自动注入 |
| `AI_TIMEOUT_MS` | `120000` | CloudBase AI 请求超时毫秒数 |
| `CHAT_MODELS` | `hy3,hy3-preview` | 允许调用的文字模型白名单 |
| `IMAGE_MODELS` | `HY-Image-3.0-Plus-4090-Tob-v1.0` | 图片模型白名单 |
| `BODY_LIMIT` | `1mb` | JSON 请求体大小上限 |
| `KEY_COLLECTION` | `ai_service_keys` | 业务访问密钥集合名称 |
| `KEY_CACHE_TTL_MS` | `10000` | 多实例密钥缓存刷新间隔 |
| `KEY_STORE` | 本地为 `file`，生产为 `cloudbase` | 设置为 `file` 或 `cloudbase` |
| `KEY_FILE` | `.service-keys.json` | 本地业务访问密钥摘要文件 |
| `CREDENTIAL_FILE` | `.cloudbase-credentials.json` | Web 后台保存的上游凭据文件 |

## 最简单的运行方法

### Windows 命令提示符（cmd）

先设置环境变量：

```bash
set ENV_ID=你的环境ID
set CLOUDBASE_APIKEY=你的APIKey
```

然后执行：

```bash
node direct-generate.js "一只橘猫坐在窗边看雨，电影感，柔和自然光" 1024x1024
```

### PowerShell

先设置环境变量：

```powershell
$env:ENV_ID="你的环境ID"
$env:CLOUDBASE_APIKEY="你的APIKey"
```

然后执行：

```powershell
node .\direct-generate.js "一只橘猫坐在窗边看雨，电影感，柔和自然光" 1024x1024
```

## 运行成功后会看到什么

成功后，终端会输出一段 JSON，例如：

```json
{
  "id": "xxxx",
  "created": 1234567890,
  "data": [
    {
      "url": "https://xxxxx"
    }
  ]
}
```

你真正要用的是这里：

- `data[0].url`

把这个链接复制到浏览器里打开，就是生成好的图片。

## 命令参数说明

命令格式是：

```bash
node direct-generate.js "提示词" 1024x1024
```

其中：

- 第一个参数：提示词
- 第二个参数：图片尺寸

如果你不传第三个参数，脚本会自动把 `footnote` 设成单空格。

## 更推荐的中文用法

如果你的提示词里有大量中文，或者你发现命令行里容易出现乱码，更推荐把提示词写进一个 `.txt` 文件，再让脚本读取这个文件。

例如先新建一个文件 `prompt.txt`，内容如下：

```text
一张简洁的信息图示，白底，三个圆角矩形从左到右排列，中间用箭头连接。第一个框内清晰写“用户”，第二个框内清晰写“云函数”，第三个框内清晰写“图片模型”。
```

然后运行：

```bash
node direct-generate.js --prompt-file prompt.txt 1024x1024
```

这种方式比直接把一大段中文写进命令行更稳。

## 示例

例如：

```bash
node direct-generate.js "赛博朋克城市夜景，雨天，霓虹灯，电影感" 1024x1024
```

## 能不能换一台电脑继续用

可以。

这个项目本身没有绑定当前这台电脑，也没有把你的密钥硬编码进脚本。

换电脑时，只要满足下面几点就能继续用：

1. 新电脑安装了 `Node.js`
2. 把这个项目文件夹复制过去
3. 在新电脑里运行 `npm install`
4. 在新电脑里重新设置：
   - `ENV_ID`
   - `CLOUDBASE_APIKEY`

也就是说，真正和账号绑定的是：

- `ENV_ID`
- `CLOUDBASE_APIKEY`

不是这台电脑本身。

## 常见问题

### 1. 提示 `Please set ENV_ID`

说明你还没有设置 `ENV_ID`。

### 2. 提示 `Please set CLOUDBASE_APIKEY`

说明你还没有设置 `CLOUDBASE_APIKEY`。

### 3. 业务 API Key 会在重启后变化吗

不会。本地服务将密钥摘要保存在 `.service-keys.json`，重启后继续使用原密钥。只有在后台主动轮换、修改或删除时才会变化。生产环境可以通过 `SERVICE_API_KEY` 设置初始值；它不是 CloudBase API Key。

### 4. 生成出来的图片和提示词不一致

优先检查这两件事：

1. 你的提示词是不是在命令行里被弄成了乱码
2. 你复制命令时是不是把引号弄错了

最稳妥的方式是先复制 README 里的示例命令，再只修改中间那段提示词。

### 5. 为什么右下角还是会残留一点点痕迹

这个项目默认不是“彻底关闭官方标识”，而是通过传单空格把右下角标识尽量缩到最小。

## 项目里还有哪些文件

- `direct-generate.js`
  这是你平时真正用来生图的脚本

- `server.js`
  这是统一 HTTP 服务的启动入口

- `app.js`
  这是管理后台、图片与文字兼容路由、鉴权和错误处理

- `admin.js`
  这是管理员登录、会话和密钥管理接口

- `key-store.js`
  这是 CloudBase 数据库密钥存储与缓存

- `cloudbase-ai.js`
  这是两个入口共用的 CloudBase AI 调用逻辑

- `Dockerfile`
  用于把整个项目部署成一个 Cloud Run 服务

- `public/`
  这是 Web 管理后台页面资源

- `package.json`
  这是依赖配置文件，`npm install` 会用到它

- `test/httpService.test.js`
  这是统一 HTTP 服务、后台密钥管理、鉴权和流式响应测试

## 许可证

本项目使用 `MIT` 协议。
