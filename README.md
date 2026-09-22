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

装好后**重启一次 DSH**（host 半要在 node 进程里装观察点），之后改配置/刷新页面即可。

## 显示规则

- 每个 step（一次模型调用）一行，紧跟该步的助手消息；
- 两个名字**原样**显示：不归一化、不剥后缀（`-latest`、日期快照都保留）、不判定严重性；
- 差异只做客观分类：**仅厂商前缀不同** / **模型名不同**；
- **逐字相同**不显示（没有可呈现的差异事实）；
- 上游**未声明**模型名不显示（不猜、不补）；
- host 半旁路观察到额外事实时多一行附加信息：**实际发出**的模型名（与请求名不同才显示）、
  **档位**（OpenAI `service_tier` 归一值 / Anthropic `usage.speed`），以及**上游先后声明过的
  多个名字**（上游自相矛盾时照实列出，不挑一个"正确"的）。

## 数据从哪来

展示用的是 durable `assistant/message` 事件里的字段：

| 字段 | 含义 |
|---|---|
| `message.source.model` | DSH 路由选定、本次请求的模型 id |
| `message.source.replayState.response.responseModel` | 上游响应声明的模型名 |

但**适配器只在部分通道写第二个字段**，这是覆盖率的全部问题所在：

| 通道 | 原生是否有值 | 原因 |
|---|---|---|
| `openai-completions` | 仅在"响应名 ≠ 请求名"时 | pi-ai 的 `openai-completions.js` 只在名字不同时写 `responseModel` |
| `openai-responses` / azure / codex | **从不** | pi-ai 这些分支根本不写该字段（实测 11000 次调用 0 条可见） |
| `anthropic-messages` | 仅在"上游换了名字"时 | `llm-pi-ai/src/replay.ts` 只在 `message.model !== requestedModel` 时取值 |
| 自研 `deepseek-messages` | 从不 | 该 envelope 里只有请求模型 |

### host 半的旁路补全

为了在不改 DSH 源码、不改依赖的前提下补齐这些通道，插件多了一个**完全旁路**的 node 半：

1. **fetch 观察点**：只在本插件建立的调用作用域内克隆响应体（`Response.clone()` 是 tee，
   不动调用方那一支），按与 sub2api 相同的语义解析 SSE / JSON 帧（terminal 帧优先、否则首个；
   名字超长截断到 200 字符、一次响应最多留档 4 个不同声明；畸形帧忽略）；
2. **观察四类事实**：上游声明的模型名、服务档位（`service_tier` / `usage.speed`，terminal 优先、
   非终结帧只在互相一致时可信、`auto` 忽略）、请求体里**实际发出**的模型名、响应体形状；
   另有两条兜底——content-type 不可信时按内容嗅探形状，响应体没声明时读响应头
   （`x-upstream-model` / `openai-model` / `x-model` / `upstream-model`）；计数、目录、鉴权类端点跳过；
   只采纳成功响应（2xx）的声明，与 sub2api 只记成功尝试一致；
3. **`llm/stream` 中间件**（cordis waterfall）：为每次模型调用建立作用域，并在 `finish` chunk 上
   **只在缺失时**补写 `response.responseModel` 与 `response.upstreamAudit`（后者承载实际发出的
   模型名、档位、形状、上游自相矛盾的多个声明）——原生值永远优先，形状不认识的
   replayState 一律不碰；
4. **中止/结束清理**：调用结束或中止时取消所有旁路读取，不会留下悬挂的 tee 分支。

补进去的值随后由 DSH 自己持久化进 durable 事件，**展示路径完全没变**：仍是浏览器半直接读
`replayState.response.responseModel`，没有新增事件类型、没有投影、没有 RPC、不进入模型上下文。

不变量：观察失败、超时、格式不认识、非 SSE/JSON 响应 —— 一律静默降级，绝不影响模型调用。

## 已知边界

- **需要重启一次 DSH**：host 半在 node 进程里装观察点，热重载不覆盖它；
- 走 `globalThis.fetch` 的 provider 才能被观察（pi-ai 的 openai SDK、自研通道的 `fetch` 都属于）；
  若将来适配器改成注入式 fetch，观察会静默失效——此时表现是"回到只有原生字段的覆盖率"，不影响任何调用；
- **没有 replayState 的调用无法补**（实测 40 次，多为中断或未正常结束的调用）：插件不伪造载体；
- 旁路观察是**尽力而为**：上游把 SSE 标成别的 content-type、把模型名只放在自定义头里，插件都做了
  兜底；但若响应体里确实没有任何模型声明，就照实不显示；
- 上游确实没声明 model 的响应仍然不显示（不猜）；
- 若上游或中转把响应 model 改写成请求名，两个名字就会相同 —— 插件只对 DSH 侧可见的事实负责；
- 原生 Trajectory 标签页不显示这些记录；
- 节点锚点 `anchorSeq = 消息 seq + 0.01` 依赖 ui-chat 取 assistant 消息 seq 的语义，DSH 升级后需复查。

## 开发

类型检查需要 DeepSeek Harness 的**类型产物**：把官方仓库 clone 到与本仓库并列的位置
（例如 `D:\Code\deepseek-harness`，即 `../../../deepseek-harness`），构建一次后
`tsconfig.json` 的 `paths` 就会指向它。CI（`.github/workflows/release.yml`）里做的是同一件事：
clone 官方仓库 → `pnpm run build:lib:host` → `tsc -b tsconfig.client.json` → 再跑下面的检查，
实测约 3 分钟。

```sh
pnpm run typecheck   # 类型检查
pnpm run build       # host 半（观察点 + 补写）+ 浏览器 bundle + 纯逻辑 dev 产物
pnpm test            # 判定逻辑与 host 旁路的规格（node --test，26 条）
```

源码布局：

| 路径 | 作用 |
|---|---|
| `src/marks.ts` | 客户端判定逻辑（提取、三态分类），零依赖、可单测 |
| `src/observe.ts` | host 侧观察逻辑（SSE/JSON 帧解析、声明聚合、补写规则），零依赖、可单测 |
| `src/host.ts` | host 半：fetch 旁路观察 + `llm/stream` 中间件补写 |
| `src/client/step-definition.ts` | 自有 Conversation Definition：每个有差异的 step 一个节点 |
| `src/client/UpstreamModelAudit.tsx` | 该节点的渲染器 |
| `src/client/index.ts` | 客户端插件体：注册 Definition、渲染器、字典、样式 |
| `src/index.ts` | node 半入口：装载观察点 |

## 许可

MIT
