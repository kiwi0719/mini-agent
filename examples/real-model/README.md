# 真实模型实跑记录

经 OpenRouter 接入，两条协议各一个性价比模型。与 [../README.md](../README.md) 的 Mock 用例不同，这里验证的是"接上真模型能不能用"。

- OpenAI 协议 · openai/gpt-4o-mini（$0.15/$0.60 per M）
- Anthropic 协议 · anthropic/claude-haiku-4.5（$1/$5 per M）

| 任务 | 端点 | 结果 | 步数 | 工具调用 | 失败 | 耗时 | tokens in/out | 用了 update_plan |
|---|---|---|---|---|---|---|---|---|
| 01 | openai-gpt-4o-mini | completed | 5 | 4 | 0 | 14.4s | 19868/690 | 是 |
| 02 | openai-gpt-4o-mini | completed | 4 | 3 | 0 | 5.6s | 13983/126 | 否 |
| 03 | openai-gpt-4o-mini | completed | 4 | 5 | 0 | 7.5s | 14670/379 | 否 |
| 11 | openai-gpt-4o-mini | completed | 9 | 8 | 0 | 14.9s | 32343/315 | 否 |
| 01 | anthropic-claude-haiku-4.5 | completed | 3 | 2 | 0 | 14.7s | 42668/1617 | 否 |
| 02 | anthropic-claude-haiku-4.5 | completed | 6 | 5 | 0 | 19.3s | 83214/1127 | 是 |
| 03 | anthropic-claude-haiku-4.5 | completed | 5 | 13 | 2 | 17.5s | 71803/2038 | 否 |
| 11 | anthropic-claude-haiku-4.5 | completed | 6 | 10 | 0 | 18.1s | 84412/1365 | 是 |

每个子目录含该次运行的 README、生成文件与完整 Trace。
