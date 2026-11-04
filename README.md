# 自动配背景音乐工作台

一款面向短剧剪辑与内容运营的本地 Windows 桌面工具。选择视频目录、按情绪整理的背景音乐库和输出目录后，应用会批量生成混合原视频声音与 BGM 的成片，并提供音频、选曲时间表和转录材料供检查。

应用在本机处理素材。自动选曲依赖现有音乐分类与转录文本规则，结果需要人工试听确认，不代表对剧情或音乐适配度的专业判断。

## 功能

- 批量扫描常见视频与音频格式，并按自然文件名排序。
- 按音乐目录分类和字幕/转录文本选择背景音乐。
- 支持淡入淡出、对白时段降低 BGM 音量、片尾定格设置和多段配乐。
- 输出最终视频、BGM-only WAV、CSV 时间表、转录 JSON 和批次摘要。
- 支持断点续跑、单集失败后继续，以及 Electron 桌面界面。
- 可选使用 faster-whisper 在本机生成对白转录。

## 获取 Windows 应用

从 GitHub Releases 下载最新的 `自动配背景音乐工作台 Setup <版本>.exe` 并运行安装程序。便携版或其他平台目前没有发布。

## 从源码运行

需要 Windows、Node.js 22.12 或更高版本，以及可从 `PATH` 调用的 FFmpeg 和 ffprobe。

```powershell
npm ci
npm test
npm run desktop
```

也可使用命令行：

```powershell
node src/cli.js `
  --videos "C:\Media\Episodes" `
  --music "C:\Media\BGM" `
  --output "C:\Media\Output" `
  --mood "默认"
```

目录参数需替换为你自己的素材位置。首次运行会要求你在应用中选择目录；程序不会把视频或音乐上传到网络。

## BGM 目录

可把音频放在情绪子目录中；直接放在根目录的曲目会归为“默认”。

```text
BGM/
  默认/calm.mp3
  悬疑/mystery.mp3
  紧张/action.wav
```

支持 `.wav`、`.mp3`、`.m4a`、`.aac`、`.flac`、`.ogg` 和 `.opus`。

## 字幕与本机转录

字幕 sidecar 为与视频同名的 JSON 文件，例如 `transcripts/episode-01.json`：

```json
{
  "segments": [
    { "start": 12.4, "end": 15.8, "text": "危险，快跑" }
  ]
}
```

```powershell
node src/cli.js --videos "C:\Media\Episodes" --music "C:\Media\BGM" --output "C:\Media\Output" --transcripts "C:\Media\Transcripts"
```

要启用 faster-whisper 转录，安装 Python 依赖并提供本机模型目录：

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:FASTER_WHISPER_MODEL = "C:\Models\faster-whisper-small"
node src/cli.js --videos "C:\Media\Episodes" --music "C:\Media\BGM" --output "C:\Media\Output" --transcribe
```

也可将 `FASTER_WHISPER_MODEL` 设为模型名称（例如 `small`），让 faster-whisper 从其配置的模型缓存中读取。转录与媒体处理在本机执行；首次获取模型可能需要网络。

## 构建 Windows 安装包

构建需要 Node.js、Python、项目依赖、PyInstaller、一个本机 faster-whisper small 模型目录，以及模型构建脚本要求的 FFmpeg 发行包。FFmpeg 下载地址和 SHA-256 校验值在 `tools/build-windows.ps1` 中维护。

```powershell
npm ci
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements-build.txt
$env:FASTER_WHISPER_MODEL = "C:\Models\faster-whisper-small"
npm run dist:win
```

模型目录必须包含 faster-whisper 模型文件。构建产物写入 `release/`，不属于源码仓库。

## 开发与测试

```powershell
npm test
```

测试需要 Node.js 和 FFmpeg/ffprobe。核心逻辑位于 `src/`，Electron 桌面端位于 `desktop/`，Windows 打包脚本位于 `tools/`。

## 已知边界

- 自动情绪判断使用关键词规则，不理解完整剧情，也不评估音乐的艺术质量。
- ASR 文本可能有误；请检查时间轴、对白清晰度、切点和最终成片。
- 仅在 Windows 环境测试和提供安装程序；没有承诺其他操作系统兼容性。
- 使用者需确保拥有输入视频和背景音乐的处理、复制及发布权利。

## 隐私与文件处理

素材路径和生成文件由用户在本机选择。`.gitignore` 排除常见的本机环境、媒体输出、运行时与安装包目录；提交前仍应检查 Git 暂存内容，避免加入私人素材或凭据。

## 许可证

此仓库当前未附开源许可证。公开可见不等于获得复制、修改或再分发代码的授权。



