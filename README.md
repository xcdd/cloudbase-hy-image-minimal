# CloudBase 图片生成最小项目

这是一个可以直接在本地电脑上运行的最小示例项目，用来调用 CloudBase 的图片模型：

- `HY-Image-3.0-Plus-4090-Tob-v1.0`

它适合下面这种场景：

- 你已经有 `ENV_ID`
- 你已经有 `CLOUDBASE_APIKEY`
- 你想最快跑通一条“输入提示词 -> 返回图片链接”的生图流程

## 这个项目帮你做了什么

这个项目已经默认处理好了这些事情：

- 默认使用模型 `HY-Image-3.0-Plus-4090-Tob-v1.0`
- 默认使用 `1024x1024` 尺寸
- 默认给 `footnote` 传一个单空格，让右下角标识尽量缩到最小

你平时最常用的文件只有这一个：

- `direct-generate.js`

## 先准备什么

在开始之前，你需要准备好：

1. 电脑里已经安装 `Node.js`
2. 你自己的 CloudBase 环境 ID
3. 你自己的 CloudBase API Key

也就是下面两个值：

- `ENV_ID`
- `CLOUDBASE_APIKEY`

如果没有这两个值，这个项目就跑不起来。

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

### 3. 生成出来的图片和提示词不一致

优先检查这两件事：

1. 你的提示词是不是在命令行里被弄成了乱码
2. 你复制命令时是不是把引号弄错了

最稳妥的方式是先复制 README 里的示例命令，再只修改中间那段提示词。

### 4. 为什么右下角还是会残留一点点痕迹

这个项目默认不是“彻底关闭官方标识”，而是通过传单空格把右下角标识尽量缩到最小。

## 项目里还有哪些文件

- `direct-generate.js`
  这是你平时真正用来生图的脚本

- `package.json`
  这是依赖配置文件，`npm install` 会用到它

- `invoke-function.js`
  这是通过云函数转发再生图的版本。大多数情况下，你可以先不用它

- `generateImage/index.js`
  这是云函数版本的入口文件

- `test/generateImage.test.js`
  这是最小测试文件

## 许可证

本项目使用 `MIT` 协议。
