window.__ModuleLoader__.load({
	id: "dsh-upstream-model-audit",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/locales.ts
		/** \`upstream-model-audit\` 命名空间字典。 */
		/** 本插件拥有的字典命名空间。 */
		const NS = "upstream-model-audit";
		/** 简体中文字典（键集合的唯一来源）。 */
		const zh = {
			"row.label": "上游返回",
			"row.meta": "请求 {requested} · {mark}",
			"row.aria": "第 {turn} 轮第 {step} 步：请求 {requested}，上游返回 {reported}",
			"mark.prefixed": "仅厂商前缀不同",
			"mark.different": "模型名不同"
		};
		/** 英文字典，与中文键集合一一对应。 */
		const en = {
			"row.label": "Upstream returned",
			"row.meta": "requested {requested} · {mark}",
			"row.aria": "Turn {turn} step {step}: requested {requested}, upstream returned {reported}",
			"mark.prefixed": "vendor prefix only",
			"mark.different": "different model name"
		};
		//#endregion
		//#region src/client/styles.ts
		/**
		* 插件自有样式表：注入一段 \`<style>\`，产物保持纯 JavaScript bundle。
		*
		* 审计行是 Chat flow 里的一个同级行，紧跟它的 assistant 消息；排版只做低干扰的
		* 次要信息（小字号、次要色、等宽模型名），不覆盖任何原生样式。
		*
		* @module dsh-upstream-model-audit/styles
		*/
		/** 样式元素标记；同时是卸载时匹配的选择器。 */
		const STYLE_TAG = "dsh-upstream-model-audit";
		const STYLES = [
			".uma-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: 6px; margin: 2px 0 6px; font-size: 11px; line-height: 16px; }",
			".uma-label { color: var(--dsw-alias-label-caption); }",
			".uma-to { color: var(--dsw-alias-label-primary); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-weight: 600; }",
			".uma-meta { color: var(--dsw-alias-label-caption); }"
		].join("\n");
		/**
		* 注入样式表。
		* @returns 移除样式表的清理函数（由 \`ctx.effect\` 在插件卸载时调用）。
		*/
		function installStyles() {
			const element = document.createElement("style");
			element.dataset.dshPlugin = STYLE_TAG;
			element.textContent = STYLES;
			document.head.appendChild(element);
			return () => {
				element.remove();
			};
		}
		//#endregion
		//#region src/marks.ts
		/**
		* 读取上游声明的模型名。
		* replayState 是适配器私有结构（会随适配器版本变化），逐层防御式读取，
		* 读不到一律返回 null，绝不猜测。
		* @param replayState - 事件里的 \`message.source.replayState\`。
		* @returns 非空字符串或 null。
		*/
		function readReportedModel(replayState) {
			if (typeof replayState !== "object" || replayState === null) return null;
			const response = replayState.response;
			if (typeof response !== "object" || response === null) return null;
			const reported = response.responseModel;
			return typeof reported === "string" && reported.length > 0 ? reported : null;
		}
		/**
		* 对两个名字做客观分类。
		* @param requested - 请求模型名。
		* @param reported - 上游声明模型名。
		* @returns 差异标记。
		*/
		function markOf(requested, reported) {
			if (requested === reported) return "identical";
			if (requested.endsWith("/" + reported) || reported.endsWith("/" + requested)) return "prefixed";
			return "different";
		}
		/**
		* 从一个会话事件里提取可显示的审计记录。
		* 只认 \`assistant/message\`；上游未声明模型名、名字逐字相同、或事件形状不认识时返回 null
		* （没有可呈现的差异事实，就不显示）。
		* @param event - 任意会话事件（结构式读取，不依赖 harness 类型）。
		* @returns 审计记录或 null。
		*/
		function auditOf(event) {
			if (event === null || event === void 0 || event.type !== "assistant/message") return null;
			const data = event.data;
			if (data === void 0 || data === null) return null;
			const source = data.message?.source;
			if (source === void 0 || source === null || source.kind !== "model") return null;
			const requested = typeof source.model === "string" && source.model.length > 0 ? source.model : null;
			const reported = readReportedModel(source.replayState);
			if (requested === null || reported === null) return null;
			const mark = markOf(requested, reported);
			if (mark === "identical") return null;
			return {
				turn: typeof data.turn === "number" ? data.turn : -1,
				step: typeof data.step === "number" ? data.step : -1,
				requested,
				reported,
				mark
			};
		}
		//#endregion
		//#region src/client/step-definition.ts
		/** 本插件节点的 kind，同时用作 \`conversation.chat.node\` 的注册 key。 */
		const STEP_AUDIT_KIND = "upstream-model-audit";
		/** 从事件载荷里读 turn/step，读不到就不认这个事件。 */
		function positionOf(event) {
			const data = event.data;
			if (data === void 0 || data === null) return null;
			return typeof data.turn === "number" && typeof data.step === "number" ? {
				turn: data.turn,
				step: data.step
			} : null;
		}
		/** 每个有差异的 step 一条审计节点，排在它的 assistant 消息之后。 */
		const upstreamModelAuditDefinition = {
			kind: STEP_AUDIT_KIND,
			target: "chat",
			match: (event) => {
				if (event.type === "step/start" || event.type === "assistant/message") {
					const position = positionOf(event);
					if (position === null) return null;
					return {
						id: position.turn + ":" + position.step,
						role: event.type === "step/start" ? "start" : "update"
					};
				}
				return null;
			},
			start: (_context, match) => {
				if (match.event.type !== "step/start") throw new Error("upstream-model-audit start requires step/start");
				return {
					turn: match.event.data.turn,
					step: match.event.data.step,
					seq: -1,
					audit: null
				};
			},
			update: (context, match) => {
				if (match.event.type !== "assistant/message") return context.state;
				return {
					...context.state,
					seq: match.event.seq,
					audit: auditOf(match.event)
				};
			},
			buildViewNode: (context) => {
				const state = context.state;
				if (state === void 0 || state.seq < 0 || state.audit === null) return null;
				const tail = context.matches.at(-1);
				return {
					key: context.key,
					kind: STEP_AUDIT_KIND,
					id: context.id,
					target: "chat",
					anchorSeq: state.seq + .01,
					location: tail?.location ?? context.start?.location ?? { kind: "unresolved" },
					visibility: "visible",
					data: state.audit
				};
			}
		};
		//#endregion
		//#region src/client/UpstreamModelAudit.tsx
		/**
		* 渲染本 step 的审计行。
		* @param props - slot 提供的节点与文案。
		* @returns 审计行。
		*/
		function UpstreamModelAudit({ node, t }) {
			const { turn, step, requested, reported, mark } = node.data;
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				className: "uma-row",
				"aria-label": t("row.aria", {
					turn: String(turn + 1),
					step: String(step + 1),
					requested,
					reported
				}),
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "uma-label",
						children: t("row.label")
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "uma-to",
						children: reported
					}),
					/* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						className: "uma-meta",
						children: t("row.meta", {
							requested,
							mark: t(mark === "prefixed" ? "mark.prefixed" : "mark.different")
						})
					})
				]
			});
		}
		//#endregion
		//#region src/client/index.ts
		/** 必需服务：slot 注册表、字典注册表，以及自有 Conversation Definition 的注册面。 */
		const inject = [
			"slots",
			"locale",
			"uiConversation"
		];
		/**
		* 客户端插件体。
		* @param ctx - 客户端根上下文。
		*/
		function apply(ctx) {
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "upstream-model-audit: dictionaries");
			ctx.effect(installStyles, "upstream-model-audit: stylesheet");
			ctx.effect(() => ctx.uiConversation.events.register(upstreamModelAuditDefinition), "upstream-model-audit: definition");
			ctx.slots.inject("conversation.chat.node", () => ctx.slots.register({
				name: "conversation.chat.node",
				key: STEP_AUDIT_KIND,
				locale: NS
			}, UpstreamModelAudit));
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});

//# sourceMappingURL=client.js.map