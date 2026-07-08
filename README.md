# 中文使用说明

这个文件夹里的脚本，可以让你在本地电脑上直接调用 CloudBase 的图片模型 `HY-Image-3.0-Plus-4090-Tob-v1.0` 来生图。

它已经默认做了这两件事：

- 默认使用模型 `HY-Image-3.0-Plus-4090-Tob-v1.0`
- 默认把右下角水印处理成“单空格”，效果上基本看不见

你平时真正要用的文件只有这个：

- `direct-generate.js`

## 你需要先准备什么

先确认电脑里有这两个东西：

1. `Node.js`
2. 你自己的 CloudBase 信息

你至少要有下面两个值：

- `ENV_ID`
- `CLOUDBASE_APIKEY`

如果没有这两个值，这个脚本跑不起来。

## 第一次使用怎么做

先进入这个文件夹：

```bash
cd C:\Users\xcdd945\Documents\Codex\2026-07-08\w\outputs\cloudbase-hy-image-minimal
```

然后安装依赖：

```bash
npm install
```

这一步只需要做一次。

## 怎么运行

### 如果你用的是 Windows 命令提示符（cmd）

先设置环境变量：

```bash
set ENV_ID=你的环境ID
set CLOUDBASE_APIKEY=你的APIKey
```

然后执行：

```bash
node direct-generate.js "一只橘猫坐在窗边看雨，电影感，柔和自然光" 1024x1024
```

### 如果你用的是 PowerShell

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

成功后，终端里会输出一段 JSON，大概长这样：

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

你真正要用的是这里面的：

- `data[0].url`

把这个链接打开，就是生成好的图片。

## 参数是什么意思

命令里这部分：

```bash
node direct-generate.js "提示词" 1024x1024
```

意思是：

- 第一个参数：提示词
- 第二个参数：图片尺寸

例如：

```bash
node direct-generate.js "赛博朋克城市夜景，雨天，霓虹灯，电影感" 1024x1024
```

## 可以换一台电脑用吗

可以。

这个脚本本身没有绑定这台电脑，也没有写死你的 Key。

换电脑时，只要满足下面几点就行：

1. 新电脑安装了 `Node.js`
2. 把这个文件夹带过去
3. 在新电脑上运行 `npm install`
4. 在新电脑上重新设置：
   - `ENV_ID`
   - `CLOUDBASE_APIKEY`

也就是说，真正和电脑无关，和你账号有关的是这两个值：

- `ENV_ID`
- `CLOUDBASE_APIKEY`

## 常见问题

### 1. 提示 `Please set ENV_ID`

说明你没有设置 `ENV_ID`。

### 2. 提示 `Please set CLOUDBASE_APIKEY`

说明你没有设置 `CLOUDBASE_APIKEY`。

### 3. 生成出来的图和提示词不一致

优先检查两件事：

1. 你的提示词是不是被命令行改成乱码了
2. 你是不是复制了错误的引号

建议直接复制 README 里的示例命令，再只改中间那段提示词。

### 4. 右下角为什么还是有一点点痕迹

这个脚本默认不是“彻底关掉官方水印”，而是自动传一个单空格，让右下角标识尽量缩到最小。

## 文件说明

- `direct-generate.js`
  这是你平时真正用来生图的脚本

- `package.json`
  这是依赖配置文件，`npm install` 会用到它

- `invoke-function.js`
  这个是“通过云函数转一次再生图”的版本。你现在最简单的情况，一般不用它
