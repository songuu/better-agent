# Architecture decisions

## Executable admission gates are closed-world

- G1 前门以冻结 manifest 和 parsed CI schema 为事实源；“包含必需命令/文本”不足以准入。
- dirty source 只能物化到 content-addressed disposable checkout；不得 stash/reset/checkout 当前工作树。
- 本地机器证据与 host-attested acceptance 分层，Provider 不得自签 Receipt。
