# faster-whisper small 模型包

- 来源：`Systran/faster-whisper-small`
- 固定 revision：`536b0662742c02347bc0e980a01041f333bce120`
- 上游模型卡元数据声明许可证：MIT；模型卡说明该 CTranslate2 权重由 `openai/whisper-small` 转换而来。Hugging Face 模型卡 revision `973afd24965f72e36ca33b3055d56a652f456b4d` 声明 Apache-2.0；Systran 的转换说明没有固定原始模型 revision。
- `model.bin` SHA-256：`3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671`
- 归档被拆成 `faster-whisper-small.zip.partNNN` 文件，每片 45,000,000 字节或更小。`tools/build-windows.ps1` 会重组归档并验证五个模型文件的 SHA-256。

源码下载包含这些分片。构建 Windows 安装包时无需单独下载模型；此模型不作为独立 Release 附件上传。

详见 [第三方组件与许可证说明](../THIRD_PARTY_NOTICES.md)。
