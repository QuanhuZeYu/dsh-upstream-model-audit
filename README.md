# dsh-upstream-model-audit

把「上游实际返回的模型名」显式化：**每一条助手消息下方**列出这次调用真正发出去的模型名、
上游响应里声明的模型名，以及两者差异的客观形态。

在 DeepSeek Harness 里，你请求的是 `mimo-v2.6-pro`，而中转/上游可能实际回的是
`xiaomi/mimo-v2.6-pro` —— 界面此前不会告诉你这件事。这个插件把它摆出来。

```
（助手消息）
上游返回 xiaomi/mimo-v2.6-pro   请求 mimo-v2.6-pro · 仅厂商前缀不同
```

## 安装

```sh
dsh plugin --profile web add github:QuanhuZeYu/dsh-upstream-model-audit
```

装到 web profile 后**刷新页面**即可（纯浏览器插件，无需重启 DSH）。

## 显示规则

- 每个 step（一次模型调用）一行，紧跟该步的助手消息；
- 两个名字**原样**显示：不归一化、不剥后缀（`-latest`、日期快照都保留）、不判定严重性；
- 差异只做客观分类：**仅厂商前缀不同** / **模型名不同**；
- **逐字相同**不显示（没有可呈现的差异事实）；
- 上游**未声明**模型名不显示（不猜、不补）。

## 数据从哪来

DSH 的 durable `assistant/message` 事件里本来就带着两个字段：

| 字段 | 含义 |
|---|---|
| `message.source.model` | DSH 路由选定、本次请求的模型 id（pi-ai 称 request identity） |
| `message.source.replayState.response.responseModel` | 上游响应声明的模型名（pi-ai 适配器保留） |

插件在自有 Conversation Definition 的 `update` 阶段直接读它们（客户端事件窗口里是完整的
`SessionEvent`），因此没有投影、没有额外传输、没有会话日志写入。历史会话打开后同样显示。

## 它不做什么

- 不新增会话事件类型、不改 DSH 源码、不需要 host 侧逻辑；
- 不注入模型上下文：不发 notice、不加 step、不产生额外模型调用；
- 不替换原生渲染器（不改 `assistant-step` 渲染器、不动 composer dock、不动 Trajectory）。

## 已知边界

- 只覆盖走 pi-ai 适配器的 provider：DeepSeek 自研通道丢弃了响应里的 model（实测 262 次调用 0 条可见）；
- **`openai-responses` 通道探测不到**（含 azure / codex 分支）：pi-ai 0.85.1 只在 completions 通道写
  `responseModel`（`dist/api/openai-completions.js:374-377`），responses 通道从不写这个字段 ——
  实测 11000 次 responses 调用 0 条可见，即使上游确实回了 model；
- **`anthropic-messages` 通道只在"上游换了名字"时有值**（`llm-pi-ai/src/replay.ts:78-79`）：
  声明名与请求名一致时不留记录；
- **一致时不留痕**：pi-ai 仅在响应 model 与请求 model **不同**时才记录该字段，因此本插件无法统计
  "一致率"，也分不清"上游没声明"与"声明了同一个名字"；
- 只有两个名字可用（请求模型 id + 上游声明名）；网关类工具能区分"用户请求名 / 实际发往上游名 /
  上游声明名"三个名字，DSH 侧没有第三份记录；
- 若上游或中转把响应 model 改写成请求名，两个名字就会相同 —— 插件只对 DSH 侧可见的事实负责；
- 原生 Trajectory 标签页不显示这些记录；
- 节点锚点 `anchorSeq = 消息 seq + 0.01` 依赖 ui-chat 取 assistant 消息 seq 的语义，DSH 升级后需复查。

## 开发

```sh
pnpm run typecheck   # 类型检查
pnpm run build       # host 半（空 apply）+ 浏览器 bundle + 纯逻辑 dev 产物
pnpm test            # 判定逻辑的行为规格（node --test）
```

源码布局：

| 路径 | 作用 |
|---|---|
| `src/marks.ts` | 纯判定逻辑（提取、三态分类），零依赖、可单测 |
| `src/client/step-definition.ts` | 自有 Conversation Definition：每个有差异的 step 一个节点 |
| `src/client/UpstreamModelAudit.tsx` | 该节点的渲染器 |
| `src/client/index.ts` | 客户端插件体：注册 Definition、渲染器、字典、样式 |
| `src/index.ts` | node 半：一行空 apply，供 Loader 使用 |

## 许可

MIT
