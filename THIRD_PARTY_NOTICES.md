# 第三方组件与许可证说明

本文件记录源码仓库和 Windows 安装包中可识别的第三方组件及其上游声明。请同时保留各组件随包提供的许可证文件和版权声明。本清单是来源说明，不为本项目原创代码授予许可证，也不替代各上游许可证文本。

## 模型

- `Systran/faster-whisper-small`，revision `536b0662742c02347bc0e980a01041f333bce120`：Hugging Face 模型卡元数据声明 MIT；该模型卡注明权重由 `openai/whisper-small` 转换而来。该固定 revision 没有单独的 LICENSE 文件；保留其声明 MIT 的原始模型卡，且在 `models/README.md` 记录来源。模型卡和文件保存在 `models/faster-whisper-small.zip.part*` 重组后的归档中。`model.bin` SHA-256 为 `3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`。
- `openai/whisper-small`：原始 Hugging Face 模型卡元数据声明 Apache-2.0。该模型被列为转换来源；本项目没有重新训练或声称拥有该模型权重。
- 项目构建的 faster-whisper / CTranslate2 推理程序分别使用 faster-whisper 1.2.1（MIT）和 CTranslate2 4.8.5（MIT）。faster-whisper 随包的 Silero VAD v6 模型声明采用 MIT；其版权说明见 `licenses/Silero-VAD-MIT.txt`。

## Windows 应用运行时

- Electron 45.2.2：Electron 的 MIT 许可证；发行包还包含 Electron/Chromium 等上游组件随发行包提供的许可证与 notices。
- FFmpeg `n9.0.2-45-g1e65c6cd5d-20261103`：使用 BtbN 的 win64 shared 构建。该构建启用 shared 与 version3，未启用 `--enable-gpl`；随安装包提供上游 `LICENSE.txt`。构建来源、归档名和 SHA-256 写在 `runtime/ffmpeg/SOURCE.txt`。
- 转录侧车还包含 PyAV 18.1.0（BSD 3-Clause）、huggingface-hub 2.4.0（Apache-2.0）、tokenizers 0.23.3（Apache-2.0）、ONNX Runtime 1.31.1（MIT）和 Silero VAD 模型（MIT）。本仓库 `licenses/` 目录保留这些组件对应的许可证文本。PyInstaller 6.16.0 使用 GPLv2-or-later with a special exception，允许用其构建并分发非自由程序；例外文本也保存在 `licenses/PyInstaller-LICENSE.txt`。

许可证文本保存在 `licenses/`：faster-whisper、CTranslate2、Electron、ONNX Runtime 和 Silero VAD 的 MIT 文本，Apache-2.0、FFmpeg LGPL、PyAV 与 PyInstaller 许可证。安装包也会附带本说明和这些文本。

## 上游来源

- faster-whisper 模型卡：<https://huggingface.co/Systran/faster-whisper-small/tree/536b0662742c02347bc0e980a01041f333bce120>
- 原始 Whisper small 模型卡（revision `973afd24965f72e36ca33b3055d56a652f456b4d`）：<https://huggingface.co/openai/whisper-small/tree/973afd24965f72e36ca33b3055d56a652f456b4d>
- faster-whisper：<https://github.com/SYSTRAN/faster-whisper>
- Silero VAD：<https://github.com/snakers4/silero-vad>
- ONNX Runtime：<https://github.com/microsoft/onnxruntime>
- CTranslate2：<https://github.com/OpenNMT/CTranslate2>
- Electron：<https://github.com/electron/electron>
- FFmpeg 构建及来源：<https://github.com/BtbN/FFmpeg-Builds/releases/tag/autobuild-2026-11-03-12-50>
- PyInstaller：<https://github.com/pyinstaller/pyinstaller>

## 本项目代码

仓库目前没有为本项目原创代码授予开源许可证。公开仓库或可下载源码不代表获得复制、修改或再分发原创代码的许可。维护者需另行选择并添加项目许可证后，才能明确授权他人使用原创代码。
