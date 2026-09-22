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
* 一次上游响应的声明聚合器（语义同 sub2api 的 `upstreamResponseModelObserver`）。
*/
var UpstreamObserver = class {
	first = "";
	terminal = "";
	conflicted = false;
	/**
	* 记录一帧声明。
	* @param model - 该帧声明的模型名；空串忽略。
	* @param terminal - 该帧是否为终结帧。
	*/
	observe(model, terminal) {
		const normalized = trimmedString(model);
		if (normalized === "") return;
		const current = this.model();
		if (current !== "" && current.toLowerCase() !== normalized.toLowerCase()) this.conflicted = true;
		if (terminal) {
			this.terminal = normalized;
			return;
		}
		if (this.first === "") this.first = normalized;
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
	}
	/** @returns 上游声明的模型名（terminal 优先，否则首个），空串表示没有声明。 */
	model() {
		return this.terminal !== "" ? this.terminal : this.first;
	}
	/** @returns 同一次响应内是否出现过互相矛盾的声明。 */
	conflict() {
		return this.conflicted;
	}
	/** @returns 当前观察结果的快照。 */
	snapshot() {
		return {
			model: this.model(),
			conflict: this.conflicted
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
* 把观察到的模型名补进 finish chunk 的 replayState。
*
* 只在 `response.responseModel` 缺失、且确实观察到了声明时写入，原生值永远优先；
* 形状不认识的 replayState 一律原样返回。pi-ai 的 `readReplayState` 只校验
* `responseModel` 必须是字符串，自研 `deepseek-messages` 的校验忽略未知字段，
* 因此这条补写对两种 envelope 都安全。
*
* @param replayState - finish chunk 上的 replayState（未知形状）。
* @param observed - 观察到的上游声明；空串表示没有声明。
* @returns 补写后的 replayState（未补写时原样返回）。
*/
function withObservedModel(replayState, observed) {
	if (observed === "") return replayState;
	const envelope = asRecord(replayState);
	if (envelope === null) return replayState;
	const response = asRecord(envelope["response"]);
	if (response === null) return replayState;
	if (typeof response["kind"] !== "string" || response["kind"] === "") return replayState;
	const current = response["responseModel"];
	if (typeof current === "string" && current !== "") return replayState;
	return {
		...envelope,
		response: {
			...response,
			responseModel: observed
		}
	};
}
//#endregion
//#region src/host.ts
/**
* 上游模型审计的 host 半：在 DSH 的 node 进程里旁路观察上游响应，并把缺失的
* `replayState.response.responseModel` 补全。
*
* 为什么需要它：pi-ai 只在 chat completions 且"响应模型名与请求名不同"时才写
* `responseModel`，responses / azure / codex 分支根本不写，Anthropic 只在换名时写；
* 于是 `openai-responses` 这类通道永远看不到上游声明的模型名（实测 11000 次调用 0 条可见）。
*
* 两个观察点，都不改变转发路径：
*
*  1. `globalThis.fetch` 旁路：只在本插件建立的调用作用域内，克隆响应体（`Response.clone()`
*     是 tee，不动调用方那一支），按与 sub2api 相同的语义解析 SSE / JSON 帧里的模型声明。
*     作用域外一律原样透传，零行为差异。
*  2. `llm/stream` 中间件（cordis waterfall）：为每次模型调用建立作用域，并在 `finish` chunk
*     上补写缺失的 `responseModel`。写进去的值随后由 DSH 自己持久化进 durable 的
*     `assistant/message` 事件，浏览器半照常读取，无需新增事件类型或传输通道。
*
* 不变量：只在字段缺失时补写；原生值永远优先；形状不认识的 replayState 一律不碰；
* 解析失败、超时、任何异常都静默降级（观察绝不影响模型调用）。
*
* @module dsh-upstream-model-audit/host
*/
/** 已打过补丁的 fetch 上的标记，保证同进程内只包装一次。 */
const PATCH_MARK = Symbol.for("dsh-upstream-model-audit/fetch-patched");
/** 补写前等待旁路解析完成的上限（毫秒）；只在确实缺字段时才等。 */
const SETTLE_TIMEOUT_MS = 300;
/** 单次模型调用的观察作用域；fetch 观察点据此把响应归属到正确的调用。 */
const scope = new AsyncLocalStorage();
/** 是否只处理 SSE / JSON 形状的响应体。 */
function isObservableContentType(contentType) {
	return contentType.includes("event-stream") || contentType.includes("json");
}
/**
* 读克隆出来的响应体并解析上游模型声明。
* @param response - `Response.clone()` 的副本。
* @param call - 该响应所属的调用作用域。
*/
async function consumeResponse(response, call) {
	const contentType = response.headers.get("content-type") ?? "";
	const body = response.body;
	if (body === null || !isObservableContentType(contentType)) {
		await body?.cancel().catch(() => void 0);
		return;
	}
	const observer = new UpstreamObserver();
	if (contentType.includes("event-stream")) {
		const reader = body.getReader();
		const decoder = new TextDecoder();
		const parser = new SseFrameParser((eventType, payload) => observer.observePayload(payload, eventType));
		for (;;) {
			const step = await reader.read();
			if (step.done) break;
			if (step.value !== void 0) parser.push(decoder.decode(step.value, { stream: true }));
		}
		parser.end();
	} else observeJsonText(await response.text(), observer);
	const declared = observer.model();
	if (declared !== "") call.declared = declared;
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
			const task = consumeResponse(response.clone(), call).catch(() => void 0);
			call.pending.add(task);
			task.finally(() => call.pending.delete(task));
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
* 等到旁路解析有结果，或超过上限。
* 已经有声明时立即返回，因此正常路径不引入任何延迟。
* @param call - 当前调用作用域。
* @param timeoutMs - 等待上限。
* @returns 观察到（或空）的模型名。
*/
async function settleDeclared(call, timeoutMs) {
	if (call.declared !== "" || call.pending.size === 0) return call.declared;
	const settled = Promise.allSettled([...call.pending]);
	await Promise.race([settled, new Promise((resolve) => {
		setTimeout(resolve, timeoutMs).unref?.();
	})]);
	return call.declared;
}
/**
* 包装一条模型调用流：建立作用域并在 finish 上补写缺失的上游模型名。
* @param next - 下游（真正的适配器流）。
* @returns 补写后的 chunk 流。
*/
async function* auditStream(next) {
	const call = {
		declared: "",
		pending: /* @__PURE__ */ new Set()
	};
	const iterator = scope.run(call, () => next()[Symbol.asyncIterator]());
	for (;;) {
		const step = await scope.run(call, () => iterator.next());
		if (step.done === true) return;
		const chunk = step.value;
		if (chunk?.type === "finish" && chunk.replayState !== void 0) {
			const declared = await settleDeclared(call, SETTLE_TIMEOUT_MS);
			const replayState = withObservedModel(chunk.replayState, declared);
			yield replayState === chunk.replayState ? chunk : {
				...chunk,
				replayState
			};
			continue;
		}
		yield chunk;
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
