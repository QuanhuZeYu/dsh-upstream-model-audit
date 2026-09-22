import { AsyncLocalStorage } from "node:async_hooks";
/** 单行缓冲上限：超长行（例如超大的 tool-call 参数）不再累积，避免内存风险。 */
const MAX_LINE_LENGTH = 1048576;
/** OpenAI Responses 的终结事件；只有这些帧的声明才是"上游实际服务了哪个模型"。 */
const TERMINAL_EVENTS = /* @__PURE__ */ new Set([
	"response.completed",
	"response.done",
	"response.failed",
	"response.incomplete",
	"response.cancelled",
	"response.canceled"
]);
/** 空事实集。 */
function emptyFacts() {
	return {
		model: "",
		serviceTier: "",
		variants: [],
		transport: "",
		sentModel: ""
	};
}
function asRecord(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : null;
}
function trimmedString(value) {
	if (typeof value !== "string") return "";
	const text = value.trim();
	if (text === "") return "";
	const runes = [...text];
	return runes.length > 200 ? runes.slice(0, 200).join("") : text;
}
/**
* 从一帧负载里取上游声明的模型名。
* 取值顺序对齐 sub2api：`response.model` → `model` → `message.model` → `modelVersion`
* → `response.modelVersion` → `response.response.modelVersion`。
* @param payload - 已解析的 JSON 负载。
* @returns 去掉首尾空白的模型名，或空串。
*/
function extractModel(payload) {
	const frame = asRecord(payload);
	if (frame === null) return "";
	const response = asRecord(frame["response"]);
	const message = asRecord(frame["message"]);
	const nested = response === null ? null : asRecord(response["response"]);
	const candidates = [
		response?.["model"],
		frame["model"],
		message?.["model"],
		frame["modelVersion"],
		response?.["modelVersion"],
		nested?.["modelVersion"]
	];
	for (const candidate of candidates) {
		const model = trimmedString(candidate);
		if (model !== "") return model;
	}
	return "";
}
/**
* 判断一帧是否 Gemini 形状（`modelVersion`）。
* Gemini 流没有统一的终结事件，每个声明都当作终态，保留最新那个。
* @param payload - 已解析的 JSON 负载。
* @returns 是否 Gemini 形状。
*/
function isGeminiShape(payload) {
	const frame = asRecord(payload);
	if (frame === null) return false;
	if (frame["modelVersion"] !== void 0) return true;
	const response = asRecord(frame["response"]);
	if (response === null) return false;
	if (response["modelVersion"] !== void 0) return true;
	const nested = asRecord(response["response"]);
	return nested !== null && nested["modelVersion"] !== void 0;
}
/**
* 归一一帧里的 OpenAI 服务档位（`service_tier`）。
* `fast` 是 `priority` 的别名；`auto` 不描述处理档位，一律忽略而不是猜。
* @param payload - 已解析的 JSON 负载。
* @returns 归一后的档位，或空串。
*/
function extractOpenAIServiceTier(payload) {
	const frame = asRecord(payload);
	if (frame === null) return "";
	const raw = asRecord(frame["response"])?.["service_tier"] ?? frame["service_tier"];
	if (typeof raw !== "string") return "";
	switch (raw.trim().toLowerCase()) {
		case "priority":
		case "fast": return "priority";
		case "default":
		case "flex":
		case "scale": return raw.trim().toLowerCase();
		default: return "";
	}
}
/**
* 提取并归一 Anthropic 的 `usage.speed`（fast / standard）。
* @param payload - 已解析的 JSON 负载。
* @returns 归一后的档位，或空串。
*/
function extractAnthropicSpeed(payload) {
	const frame = asRecord(payload);
	if (frame === null) return "";
	const message = asRecord(frame["message"]);
	const messageUsage = message === null ? null : asRecord(message["usage"]);
	const usage = asRecord(frame["usage"]);
	const raw = messageUsage?.["speed"] ?? usage?.["speed"];
	if (typeof raw !== "string") return "";
	const value = raw.trim().toLowerCase();
	return value === "fast" || value === "standard" ? value : "";
}
/**
* 从请求体文本里取实际发往上游的模型名。
* @param body - 请求体（通常是 JSON 字符串）。
* @returns 模型名，或空串。
*/
function extractSentModel(body) {
	const text = body.trim();
	if (text === "" || text[0] !== "{") return "";
	try {
		const parsed = asRecord(JSON.parse(text));
		return parsed === null ? "" : trimmedString(parsed["model"]);
	} catch {
		return "";
	}
}
/**
* 一次上游响应的声明聚合器（模型名语义同 sub2api 的 `upstreamResponseModelObserver`）。
*/
var UpstreamObserver = class {
	first = "";
	terminal = "";
	seen = [];
	firstTier = "";
	terminalTier = "";
	tierConflict = false;
	transport = "";
	/**
	* 记录一帧模型名声明。
	* @param model - 该帧声明的模型名；空串忽略。
	* @param terminal - 该帧是否为终结帧。
	*/
	observe(model, terminal) {
		const normalized = trimmedString(model);
		if (normalized === "") return;
		this.remember(normalized);
		if (terminal) {
			this.terminal = normalized;
			return;
		}
		if (this.first === "") this.first = normalized;
	}
	/**
	* 记录一次服务档位声明。
	* @param tier - 已归一的档位；空串忽略。
	* @param terminal - 该声明是否来自终结帧。
	*/
	observeServiceTier(tier, terminal) {
		if (tier === "") return;
		if (terminal) {
			this.terminalTier = tier;
			return;
		}
		if (this.firstTier === "") {
			this.firstTier = tier;
			return;
		}
		if (this.firstTier !== tier) this.tierConflict = true;
	}
	/**
	* 记录响应体的形状。
	* @param transport - `sse` / `json`。
	*/
	observeTransport(transport) {
		if (this.transport === "" && transport !== "") this.transport = transport;
	}
	/**
	* 记录一帧原始负载。
	* @param payload - 已解析的 JSON 负载。
	* @param eventType - SSE 的 `event:` 名（无则空串）。
	*/
	observePayload(payload, eventType) {
		const model = extractModel(payload);
		if (model === "") return;
		const typed = eventType.trim();
		const terminal = TERMINAL_EVENTS.has(typed) || isGeminiShape(payload);
		this.observe(model, terminal);
		const openaiTier = extractOpenAIServiceTier(payload);
		if (openaiTier !== "" && (terminal || typed === "")) this.observeServiceTier(openaiTier, terminal);
		const speed = extractAnthropicSpeed(payload);
		if (speed !== "") this.observeServiceTier(speed, false);
	}
	remember(model) {
		if (this.seen.some((existing) => existing.toLowerCase() === model.toLowerCase())) return;
		if (this.seen.length >= 4) return;
		this.seen.push(model);
	}
	/** @returns 上游声明的模型名（terminal 优先，否则首个），空串表示没有声明。 */
	model() {
		return this.terminal !== "" ? this.terminal : this.first;
	}
	/** @returns 上游声明的服务档位（terminal 优先，非终结声明只在一致时可信）。 */
	serviceTier() {
		if (this.terminalTier !== "") return this.terminalTier;
		return this.tierConflict ? "" : this.firstTier;
	}
	/** @returns 响应体形状。 */
	observedTransport() {
		return this.transport;
	}
	/** @returns 同一次响应内是否出现过互相矛盾的模型声明。 */
	conflict() {
		return this.seen.length > 1;
	}
	/** @returns 当前观察结果的快照。 */
	snapshot() {
		return {
			model: this.model(),
			serviceTier: this.serviceTier(),
			variants: this.seen.length > 1 ? [...this.seen] : [],
			transport: this.transport,
			sentModel: ""
		};
	}
};
/**
* SSE 帧解析器：把字节流切成 (event, data) 分发给观察器。
* 只认 `event:` / `data:` 两种字段，忽略注释、id、retry 与 `[DONE]`。
*/
var SseFrameParser = class {
	onFrame;
	buffer = "";
	eventType = "";
	dataLines = [];
	/**
	* @param onFrame - 收到一个完整帧时回调。
	*/
	constructor(onFrame) {
		this.onFrame = onFrame;
	}
	/**
	* 喂入一段文本（可跨帧边界）。
	* @param text - 新增的响应文本。
	*/
	push(text) {
		this.buffer += text;
		let index = this.buffer.indexOf("\n");
		while (index >= 0) {
			const line = this.buffer.slice(0, index).replace(/\r$/, "");
			this.buffer = this.buffer.slice(index + 1);
			this.line(line);
			index = this.buffer.indexOf("\n");
		}
		if (this.buffer.length > MAX_LINE_LENGTH) this.buffer = "";
	}
	/** 流结束时冲刷残留缓冲。 */
	end() {
		if (this.buffer !== "") {
			this.line(this.buffer.replace(/\r$/, ""));
			this.buffer = "";
		}
		this.dispatch();
	}
	line(line) {
		if (line === "") {
			this.dispatch();
			return;
		}
		if (line.startsWith(":")) return;
		const colon = line.indexOf(":");
		const field = colon < 0 ? line : line.slice(0, colon);
		let value = colon < 0 ? "" : line.slice(colon + 1);
		if (value.startsWith(" ")) value = value.slice(1);
		if (field === "event") this.eventType = value;
		else if (field === "data") this.dataLines.push(value);
	}
	dispatch() {
		const eventType = this.eventType;
		const data = this.dataLines.join("\n");
		this.eventType = "";
		this.dataLines = [];
		if (data === "" || data === "[DONE]") return;
		let payload;
		try {
			payload = JSON.parse(data);
		} catch {
			return;
		}
		this.onFrame(eventType, payload);
	}
};
/**
* 解析一整段 JSON 文本（非流式响应体）。
* @param text - 响应体文本。
* @param observer - 目标观察器。
*/
function observeJsonText(text, observer) {
	const trimmed = text.trim();
	if (trimmed === "") return;
	try {
		observer.observePayload(JSON.parse(trimmed), "");
	} catch {}
}
/**
* 判断一段（可能是响应体开头的）文本看起来像什么。
* 有些中转不给正确的 content-type，这里按内容兜底判定。
* @param text - 文本开头。
* @returns `sse` / `json` / 空串。
*/
function sniffTransport(text) {
	const head = text.trimStart();
	if (head.startsWith("data:") || head.startsWith("event:") || head.startsWith(":")) return "sse";
	if (head.startsWith("{") || head.startsWith("[")) return "json";
	return "";
}
/**
* 把观察到的事实补进 finish chunk 的 replayState。
*
* 两条补写规则，都只在字段缺失时生效：
*   - `response.responseModel`：上游声明的模型名（原生值永远优先）；
*   - `response.upstreamAudit`：本插件观察到的附加上下文（实际发出的模型名、服务档位、
*     响应体形状、上游自相矛盾的多个声明）。
*
* `upstreamAudit` 是 replayState 上的未知字段：pi-ai 的 `readReplayState` 只校验已知
* 字段的类型，自研 `deepseek-messages` 的校验同样忽略未知字段，因此两种 envelope 都安全。
* 形状不认识的 replayState 一律原样返回。
*
* @param replayState - finish chunk 上的 replayState（未知形状）。
* @param facts - 观察到的事实。
* @returns 补写后的 replayState（未补写时原样返回）。
*/
function withObservedFacts(replayState, facts) {
	const envelope = asRecord(replayState);
	if (envelope === null) return replayState;
	const response = asRecord(envelope["response"]);
	if (response === null) return replayState;
	if (typeof response["kind"] !== "string" || response["kind"] === "") return replayState;
	const audit = {};
	if (facts.sentModel !== "") audit["sentModel"] = facts.sentModel;
	if (facts.serviceTier !== "") audit["serviceTier"] = facts.serviceTier;
	if (facts.transport !== "") audit["transport"] = facts.transport;
	if (facts.variants.length > 1) audit["variants"] = [...facts.variants];
	const hasAudit = Object.keys(audit).length > 0;
	const current = response["responseModel"];
	const needsModel = facts.model !== "" && !(typeof current === "string" && current !== "");
	const needsAudit = hasAudit && asRecord(response["upstreamAudit"]) === null;
	if (!needsModel && !needsAudit) return replayState;
	const nextResponse = { ...response };
	if (needsModel) nextResponse["responseModel"] = facts.model;
	if (needsAudit) nextResponse["upstreamAudit"] = audit;
	return {
		...envelope,
		response: nextResponse
	};
}
//#endregion
//#region src/host.ts
/**
* 上游模型审计的 host 半：在 DSH 的 node 进程里旁路观察上游响应，并把缺失的事实
* 补进 durable 的 replayState。
*
* 为什么需要它：pi-ai 只在 chat completions 且"响应模型名与请求名不同"时才写
* `responseModel`，responses / azure / codex 分支根本不写，Anthropic 只在换名时写；
* 自研通道只留请求模型。于是这些通道的上游声明永远看不到（实测 11000 次 responses 调用 0 条可见）。
*
* 两个观察点，都不改变转发路径：
*
*  1. `globalThis.fetch` 旁路：只在本插件建立的调用作用域内，克隆响应体（`Response.clone()`
*     是 tee，不动调用方那一支），读取上游声明的模型名、服务档位与响应形状；请求体可读时
*     顺带记录实际发往上游的模型名；响应头里的上游模型名作为兜底。
*  2. `llm/stream` 中间件（cordis waterfall）：为每次模型调用建立作用域，并在 `finish` chunk
*     上补写缺失的 `responseModel` 与 `response.upstreamAudit`。写进去的值随后由 DSH 自己
*     持久化进 durable 的 `assistant/message` 事件，浏览器半照常读取。
*
* 不变量：只在字段缺失时补写；原生值永远优先；只采纳成功响应（2xx）的声明；
* 形状不认识的 replayState 一律不碰；解析失败、超时、任何异常都静默降级。
*
* @module dsh-upstream-model-audit/host
*/
/** 已打过补丁的 fetch 上的标记，保证同进程内只包装一次。 */
const PATCH_MARK = Symbol.for("dsh-upstream-model-audit/fetch-patched");
/** 补写前等待旁路解析完成的上限（毫秒）；只在确实缺事实时才等。 */
const SETTLE_TIMEOUT_MS = 300;
/** 非流式 JSON 体的读取上限，避免异常响应把内存吃光。 */
const MAX_JSON_BODY = 8388608;
/** 与模型声明无关的端点：计数、目录、鉴权，跳过不观察。 */
const SKIP_ENDPOINT = /\/(?:count_tokens|models|oauth|token)(?:\/|\?|$)/;
/** 响应头里可能携带上游模型名的字段（按优先级）。 */
const MODEL_HEADERS = [
	"x-upstream-model",
	"openai-model",
	"x-model",
	"upstream-model"
];
/** 单次模型调用的观察作用域；fetch 观察点据此把响应归属到正确的调用。 */
const scope = new AsyncLocalStorage();
/** 该 URL 是否值得观察。 */
function shouldObserve(url) {
	return !SKIP_ENDPOINT.test(url);
}
/** 从响应头里读上游模型名（兜底，仅当响应体没有声明时使用）。 */
function headerModel(response) {
	for (const name of MODEL_HEADERS) {
		const value = response.headers.get(name);
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return "";
}
/** 取请求体里实际发往上游的模型名。 */
function sentModelOf(init) {
	const body = init?.body;
	return typeof body === "string" ? extractSentModel(body) : "";
}
/**
* 读响应体并解析上游声明。content-type 不可信时按内容兜底判定形状。
* @param response - 克隆出来的响应。
* @param observer - 目标观察器。
* @param declared - content-type 判定的形状（`sse` / `json` / 空串）。
* @param call - 所属调用作用域（用于统一清理悬挂读取）。
* @param signal - 调用方的中止信号。
*/
async function readInto(response, observer, declared, call, signal) {
	const body = response.body;
	if (body === null) return;
	const reader = body.getReader();
	const cancel = () => {
		reader.cancel().catch(() => void 0);
	};
	const onAbort = () => cancel();
	call.cancels.add(cancel);
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		let kind = declared;
		const first = await reader.read();
		if (first.done === true) {
			observer.observeTransport(kind === "" ? "json" : kind);
			return;
		}
		const decoder = new TextDecoder();
		let buffered = decoder.decode(first.value, { stream: true });
		if (kind === "") kind = sniffTransport(buffered);
		if (kind === "") {
			observer.observeTransport("json");
			return;
		}
		observer.observeTransport(kind);
		if (kind === "sse") {
			const parser = new SseFrameParser((eventType, payload) => observer.observePayload(payload, eventType));
			parser.push(buffered);
			for (;;) {
				const step = await reader.read();
				if (step.done === true) break;
				if (step.value !== void 0) parser.push(decoder.decode(step.value, { stream: true }));
			}
			parser.end();
			return;
		}
		for (;;) {
			const step = await reader.read();
			if (step.done === true) break;
			if (step.value === void 0) continue;
			buffered += decoder.decode(step.value, { stream: true });
			if (buffered.length > MAX_JSON_BODY) break;
		}
		observeJsonText(buffered, observer);
	} finally {
		signal?.removeEventListener("abort", onAbort);
		call.cancels.delete(cancel);
		cancel();
	}
}
/**
* 观察一次响应：读体、必要时用响应头兜底，然后记进调用作用域。
* @param response - 克隆出来的响应。
* @param call - 所属调用作用域。
* @param sentModel - 请求体里实际发往上游的模型名。
* @param signal - 调用方的中止信号。
*/
async function observeResponse(response, call, sentModel, signal) {
	const contentType = (response.headers.get("content-type") ?? "").toLowerCase();
	const declared = contentType.includes("event-stream") ? "sse" : contentType.includes("json") ? "json" : "";
	const observer = new UpstreamObserver();
	await readInto(response, observer, declared, call, signal);
	if (observer.model() === "") {
		const fromHeader = headerModel(response);
		if (fromHeader !== "") observer.observe(fromHeader, true);
	}
	call.observations.push({
		ok: response.ok,
		facts: {
			...observer.snapshot(),
			sentModel
		}
	});
}
/**
* 包装 `globalThis.fetch`：只在本插件的作用域内克隆并旁路解析响应体。
* @returns 卸载函数；若本进程已装过补丁则返回空操作。
*/
function installFetchObserver() {
	const current = globalThis.fetch;
	if (typeof current !== "function") return () => void 0;
	if (current[PATCH_MARK] === true) return () => void 0;
	const original = globalThis.fetch;
	const patched = async function patchedFetch(input, init) {
		const response = await original(input, init);
		const call = scope.getStore();
		if (call === void 0) return response;
		try {
			if (shouldObserve(typeof input === "string" ? input : input instanceof URL ? input.href : input.url)) {
				const sentModel = sentModelOf(init);
				const signal = init?.signal ?? (input instanceof Request ? input.signal : null);
				const task = observeResponse(response.clone(), call, sentModel, signal).catch(() => void 0);
				call.pending.add(task);
				task.finally(() => call.pending.delete(task));
			}
		} catch {}
		return response;
	};
	patched[PATCH_MARK] = true;
	globalThis.fetch = patched;
	return () => {
		if (globalThis.fetch === patched) globalThis.fetch = original;
	};
}
/**
* 汇总这次调用的最终事实：取最后一个成功且确有声明的响应。
* @param call - 当前调用作用域。
* @returns 观察到的事实；没有可用声明时为空事实。
*/
function finalFacts(call) {
	for (let index = call.observations.length - 1; index >= 0; index -= 1) {
		const observation = call.observations[index];
		if (observation !== void 0 && observation.ok && observation.facts.model !== "") return observation.facts;
	}
	return emptyFacts();
}
/**
* 等到旁路解析有结果，或超过上限。
* 已经有可用声明时立即返回，因此正常路径不引入任何延迟。
* @param call - 当前调用作用域。
* @param timeoutMs - 等待上限。
* @returns 最终事实。
*/
async function settleFacts(call, timeoutMs) {
	if (call.pending.size > 0 && finalFacts(call).model === "") {
		const settled = Promise.allSettled([...call.pending]);
		await Promise.race([settled, new Promise((resolve) => {
			setTimeout(resolve, timeoutMs).unref?.();
		})]);
	}
	return finalFacts(call);
}
/**
* 包装一条模型调用流：建立作用域并在 finish 上补写缺失的上游事实。
* @param next - 下游（真正的适配器流）。
* @returns 补写后的 chunk 流。
*/
async function* auditStream(next) {
	const call = {
		observations: [],
		pending: /* @__PURE__ */ new Set(),
		cancels: /* @__PURE__ */ new Set()
	};
	try {
		const iterator = scope.run(call, () => next()[Symbol.asyncIterator]());
		for (;;) {
			const step = await scope.run(call, () => iterator.next());
			if (step.done === true) return;
			const chunk = step.value;
			if (chunk?.type === "finish" && chunk.replayState !== void 0) {
				const facts = await settleFacts(call, SETTLE_TIMEOUT_MS);
				const replayState = withObservedFacts(chunk.replayState, facts);
				yield replayState === chunk.replayState ? chunk : {
					...chunk,
					replayState
				};
				continue;
			}
			yield chunk;
		}
	} finally {
		for (const cancel of [...call.cancels]) cancel();
	}
}
/**
* 建立 `llm/stream` 中间件。
* @returns 可直接注册的监听器。
*/
function createStreamListener() {
	return (_options, next) => auditStream(next);
}
/**
* 安装 host 半的全部观察点。
* @param ctx - cordis 上下文。
* @returns 卸载函数。
*/
function installUpstreamAudit(ctx) {
	const onAny = ctx.on;
	const disposeStream = onAny("llm/stream", createStreamListener());
	const disposeFetch = installFetchObserver();
	return () => {
		disposeStream();
		disposeFetch();
	};
}
//#endregion
//#region src/index.ts
/**
* 装载 host 半：注册 `llm/stream` 中间件与 fetch 旁路观察，随插件卸载一起拆除。
* @param ctx - cordis 上下文。
*/
function apply(ctx) {
	ctx.effect(() => installUpstreamAudit(ctx));
}
//#endregion
export { apply };
