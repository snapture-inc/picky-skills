#!/usr/bin/env node
// Picky — local verifier CLI. Node >=18, zero dependencies.
// Every subcommand prints exactly one JSON object to stdout and nothing else.
// Nothing here ever transmits task/deliverable content anywhere — `check` is pure local
// computation, and `submit` only ever sends the enum/numeric telemetry shape.
//
// No npm dependencies on purpose: `npx skills add` installs this file by copying it into
// whichever agent's skills directory, with no `npm install` step. A dependency here would
// silently break on first run.

import { readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const MCP_URL = process.env.PICKY_MCP_URL ?? "https://picky.snaptu.re/mcp";
const PICKY_DIR = join(homedir(), ".picky");
const NOTICE_PATH = join(PICKY_DIR, "notice_shown");

// Telemetry is ON by default — every verified purchase that contributes a verdict makes the
// shared ranking better for the next buyer. Opt out with `export PICKY_TELEMETRY=0`.
function telemetryEnabled() {
	return process.env.PICKY_TELEMETRY !== "0";
}

function printNoticeIfFirstRun() {
	mkdirSync(PICKY_DIR, { recursive: true });
	if (existsSync(NOTICE_PATH)) return;
	writeFileSync(NOTICE_PATH, String(Date.now()), "utf8");
	process.stderr.write(
		[
			"Picky telemetry is ON by default.",
			"Why: Picky's rankings are only as good as the verdicts that feed them — the more real,",
			"paid purchases get verified and submitted, the more accurate the ranking is for the next",
			"person picking an agent. Your contribution helps everyone, including you next time.",
			"Each verification sends ONLY: asp_id, settlement_tx, tier, topic tags, 0-100 dimension",
			"scores, failed-type tags, price paid, latency. Never task content, deliverable content,",
			"or free text. Picky's server verifies settlement_tx on-chain before accepting it — no",
			"real purchase, no submission.",
			"Don't want to contribute? Opt out any time: export PICKY_TELEMETRY=0",
			"See https://picky.snaptu.re/methodology for the full scoring methodology.",
		].join("\n") + "\n",
	);
}

function output(obj) {
	process.stdout.write(JSON.stringify(obj) + "\n");
}

function fail(reason) {
	output({ pass: false, evidence: reason });
	process.exitCode = 1;
}

function readInput(inputArg) {
	if (inputArg === "-" || !inputArg) {
		return readFileSync(0, "utf8");
	}
	return readFileSync(inputArg, "utf8");
}

function parseArgs(argv) {
	const args = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a.startsWith("--")) {
			const key = a.slice(2);
			const next = argv[i + 1];
			if (next === undefined || next.startsWith("--")) {
				args[key] = true;
			} else {
				args[key] = next;
				i++;
			}
		}
	}
	return args;
}

// ---- check --type format ----
const FORMAT_VALIDATORS = {
	json: (s) => {
		JSON.parse(s);
		return true;
	},
	csv: (s) => {
		const lines = s.trim().split(/\r?\n/);
		if (lines.length === 0) return false;
		const cols = lines[0].split(",").length;
		return lines.every((l) => l.split(",").length === cols);
	},
	url: (s) => {
		new URL(s.trim());
		return true;
	},
	email: (s) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.trim()),
	uuid: (s) => /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(s.trim()),
};

function checkFormat(args) {
	const format = args.format;
	if (!format || !FORMAT_VALIDATORS[format]) {
		return fail(`unknown --format "${format}", expected one of ${Object.keys(FORMAT_VALIDATORS).join("|")}`);
	}
	const content = readInput(args.input);
	try {
		const ok = FORMAT_VALIDATORS[format](content);
		output({ pass: !!ok, evidence: ok ? `matches format ${format}` : `does not match format ${format}` });
	} catch (e) {
		output({ pass: false, evidence: `does not match format ${format}: ${e.message}` });
	}
}

// ---- check --type schema ----
// Minimal JSON Schema subset: type, properties, required, items, enum. Not a full JSON Schema
// implementation — sufficient for deliverable shape checks, not general-purpose validation.
function validateAgainstSchema(value, schema, path = "$") {
	const errors = [];
	if (schema.enum && !schema.enum.includes(value)) {
		errors.push(`${path}: not in enum [${schema.enum.join(", ")}]`);
		return errors;
	}
	if (schema.type) {
		const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
		if (actual !== schema.type) {
			errors.push(`${path}: expected type ${schema.type}, got ${actual}`);
			return errors;
		}
	}
	if (schema.type === "object" && value && typeof value === "object") {
		for (const req of schema.required ?? []) {
			if (!(req in value)) errors.push(`${path}: missing required property "${req}"`);
		}
		for (const [key, subSchema] of Object.entries(schema.properties ?? {})) {
			if (key in value) errors.push(...validateAgainstSchema(value[key], subSchema, `${path}.${key}`));
		}
	}
	if (schema.type === "array" && Array.isArray(value) && schema.items) {
		value.forEach((item, i) => errors.push(...validateAgainstSchema(item, schema.items, `${path}[${i}]`)));
	}
	return errors;
}

function checkSchema(args) {
	if (!args.schema) return fail("missing --schema <path-to-json-schema>");
	const content = readInput(args.input);
	let value, schema;
	try {
		value = JSON.parse(content);
	} catch (e) {
		return fail(`input is not valid JSON: ${e.message}`);
	}
	try {
		schema = JSON.parse(readFileSync(args.schema, "utf8"));
	} catch (e) {
		return fail(`could not read/parse --schema file: ${e.message}`);
	}
	const errors = validateAgainstSchema(value, schema);
	output({ pass: errors.length === 0, evidence: errors.length === 0 ? "matches schema" : errors.join("; ") });
}

// ---- check --type count ----
function resolvePath(value, pointer) {
	if (!pointer) return value;
	let current = value;
	for (const segment of pointer.split(".").filter(Boolean)) {
		if (current == null) return undefined;
		current = current[segment];
	}
	return current;
}

function checkCount(args) {
	const content = readInput(args.input);
	let target;
	try {
		const parsed = JSON.parse(content);
		target = resolvePath(parsed, args.path);
	} catch {
		target = content.trim().length === 0 ? [] : content.trim().split(/\r?\n/);
	}
	const count = Array.isArray(target) ? target.length : typeof target === "string" ? target.length : undefined;
	if (count === undefined) return fail("could not resolve a countable array/string at --path");
	const min = args.min !== undefined ? Number(args.min) : -Infinity;
	const max = args.max !== undefined ? Number(args.max) : Infinity;
	const pass = count >= min && count <= max;
	output({ pass, evidence: `count=${count}, expected [${min}, ${max}]` });
}

// ---- check --type regex ----
function checkRegex(args) {
	if (!args.pattern) return fail("missing --pattern");
	const content = readInput(args.input);
	let re;
	try {
		re = new RegExp(args.pattern, typeof args.flags === "string" ? args.flags : undefined);
	} catch (e) {
		return fail(`invalid --pattern: ${e.message}`);
	}
	const pass = re.test(content);
	output({ pass, evidence: pass ? `matched /${args.pattern}/` : `no match for /${args.pattern}/` });
}

// ---- check --type url ----
async function checkUrl(args) {
	if (!args.url) return fail("missing --url");
	try {
		let res = await fetch(args.url, { method: "HEAD" });
		if (res.status === 405 || res.status === 501) res = await fetch(args.url, { method: "GET" });
		const pass = res.status < 400;
		output({ pass, evidence: `HTTP ${res.status}` });
	} catch (e) {
		output({ pass: false, evidence: `request failed: ${e.message}` });
	}
}

async function cmdCheck(args) {
	switch (args.type) {
		case "format":
			return checkFormat(args);
		case "schema":
			return checkSchema(args);
		case "count":
			return checkCount(args);
		case "regex":
			return checkRegex(args);
		case "url":
			return checkUrl(args);
		default:
			return fail(`unknown --type "${args.type}", expected one of format|schema|count|regex|url`);
	}
}

// ---- notice ----
// No install_token anymore — Picky's server authenticates a submission purely by verifying
// settlement_tx on-chain (a real, paid transaction), not by any client-generated identity.
function cmdNotice() {
	printNoticeIfFirstRun();
	output({ telemetry_enabled: telemetryEnabled() });
}

// ---- submit (calls the free submit_verdict MCP tool) ----
const TIER_VALUES = ["verified", "warn", "failed", "inconclusive"];
const FAILED_TYPE_VALUES = ["format", "factual", "completeness", "freshness", "honesty"];
const TAG_VALUES = [
	"token-price",
	"market-data",
	"onchain-query",
	"arbitrage-signal",
	"token-risk",
	"sports-prediction",
	"fact-check",
	"web-research",
	"report-writing",
	"translation",
	"csv-export",
	"data-extraction",
	"image-gen",
	"nft-mint",
	"food-health",
	"cooking",
	"code-gen",
	"other",
];

// Minimal hand-rolled validation of the submit_verdict shape — no zod, see the
// zero-dependency note above.
function validateSubmitArgs(candidate) {
	const errors = [];
	if (typeof candidate.asp_id !== "string" || candidate.asp_id.length === 0 || candidate.asp_id.length > 128) {
		errors.push("asp_id must be a non-empty string, max 128 chars");
	}
	if (!TIER_VALUES.includes(candidate.tier)) {
		errors.push(`tier must be one of ${TIER_VALUES.join("|")}`);
	}
	if (!Array.isArray(candidate.topics) || candidate.topics.length < 1 || candidate.topics.length > 3) {
		errors.push("topics must be an array of 1-3 tags");
	} else if (!candidate.topics.every((t) => TAG_VALUES.includes(t))) {
		errors.push(`topics entries must be one of ${TAG_VALUES.join("|")}`);
	}
	if (!candidate.dims || typeof candidate.dims !== "object" || Array.isArray(candidate.dims)) {
		errors.push("dims must be an object");
	} else {
		for (const [k, v] of Object.entries(candidate.dims)) {
			if (typeof v !== "number" || v < 0 || v > 100) errors.push(`dims.${k} must be a number 0-100`);
		}
	}
	if (!Array.isArray(candidate.failed_types) || candidate.failed_types.length > 5) {
		errors.push("failed_types must be an array, max 5 entries");
	} else if (!candidate.failed_types.every((t) => FAILED_TYPE_VALUES.includes(t))) {
		errors.push(`failed_types entries must be one of ${FAILED_TYPE_VALUES.join("|")}`);
	}
	if (typeof candidate.settlement_tx !== "string" || candidate.settlement_tx.length === 0) {
		errors.push("settlement_tx must be a non-empty string (the on-chain tx hash for the purchase)");
	}
	if (
		candidate.price_paid_usd !== undefined &&
		(typeof candidate.price_paid_usd !== "number" || candidate.price_paid_usd < 0 || candidate.price_paid_usd > 1000)
	) {
		errors.push("price_paid_usd must be a number 0-1000");
	}
	if (candidate.latency_ms !== undefined && !Number.isInteger(candidate.latency_ms)) {
		errors.push("latency_ms must be an integer");
	}
	return errors;
}

// A 402 thrown by mcpToolCall — this is Step A1 of the OKX Agent Payments Protocol's Path A
// ("you already have the original HTTP response"), not a custom error path. We deliberately do
// NOT decode/interpret the challenge or guess a payment scheme or header name here — that's the
// job of the okx-agent-payments-protocol skill (see SKILL.md Trigger A). This just hands back
// the raw, undecoded `PAYMENT-REQUIRED` value exactly as received.
class PaymentRequiredError extends Error {
	constructor({ paymentRequiredHeader, resource }) {
		super("payment required");
		this.name = "PaymentRequiredError";
		this.paymentRequiredHeader = paymentRequiredHeader;
		this.resource = resource;
	}
}

// Paid Picky MCP tools (rank_agents, get_scorecard) are gated behind HTTP 402 (x402 v2): the
// first call with no payment header gets a `PAYMENT-REQUIRED` response header (base64 JSON)
// instead of a result. `submit_verdict` (used by `cmdSubmit`) is free and never hits this path.
// `paymentHeader`, when provided, is `{name, value}` — the `header_name`/`authorization_header`
// pair returned by `onchainos payment pay`, replayed verbatim on the paid retry.
async function mcpToolCall(toolName, toolArgs, paymentHeader) {
	const initRes = await fetch(MCP_URL, {
		method: "POST",
		headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2024-11-05",
				capabilities: {},
				clientInfo: { name: "picky-skills", version: "0.1.0" },
			},
		}),
	});
	const sessionId = initRes.headers.get("mcp-session-id");
	await initRes.text();

	const callRes = await fetch(MCP_URL, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			accept: "application/json, text/event-stream",
			...(sessionId ? { "mcp-session-id": sessionId } : {}),
			...(paymentHeader ? { [paymentHeader.name]: paymentHeader.value } : {}),
		},
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 2,
			method: "tools/call",
			params: { name: toolName, arguments: toolArgs },
		}),
	});

	if (callRes.status === 402) {
		const paymentRequiredHeader = callRes.headers.get("payment-required");
		if (!paymentRequiredHeader) throw new Error("402 response carried no PAYMENT-REQUIRED header");
		throw new PaymentRequiredError({ paymentRequiredHeader, resource: MCP_URL });
	}

	const raw = await callRes.text();

	if (!callRes.ok) {
		// RFC 9457 Problem Details (what Cloudflare/most JSON APIs send for 4xx/5xx) — surface
		// `detail`/`title` rather than reporting success with an empty result.
		let detail = raw;
		try {
			const problem = JSON.parse(raw);
			detail = problem.detail ?? problem.title ?? problem.message ?? raw;
		} catch {}
		throw new Error(`Picky MCP endpoint returned HTTP ${callRes.status}: ${detail}`);
	}

	const dataLine = raw.split("\n").find((l) => l.startsWith("data:"));
	const jsonText = dataLine ? dataLine.slice(5).trim() : raw.trim();
	const parsed = JSON.parse(jsonText);
	if (parsed.error) throw new Error(parsed.error.message ?? "MCP error");
	const text = parsed.result?.content?.[0]?.text;
	return text ? JSON.parse(text) : parsed.result;
}

async function cmdSubmit(args) {
	if (!telemetryEnabled()) {
		return output({ ok: false, reason: "telemetry_disabled" });
	}
	printNoticeIfFirstRun();

	const candidate = {
		asp_id: args["asp-id"],
		tier: args.tier,
		topics: typeof args.topics === "string" ? args.topics.split(",") : args.topics,
		dims: args.dims ? JSON.parse(args.dims) : undefined,
		failed_types:
			typeof args["failed-types"] === "string"
				? args["failed-types"].split(",").filter(Boolean)
				: (args["failed-types"] ?? []),
		settlement_tx: args["settlement-tx"],
		price_paid_usd: args["price-paid-usd"] !== undefined ? Number(args["price-paid-usd"]) : undefined,
		latency_ms: args["latency-ms"] !== undefined ? Number(args["latency-ms"]) : undefined,
	};
	const errors = validateSubmitArgs(candidate);
	if (errors.length > 0) {
		return output({ ok: false, reason: "invalid_input", details: errors });
	}

	try {
		const result = await mcpToolCall("submit_verdict", candidate);
		output(result);
	} catch (e) {
		output({ ok: false, reason: "request_failed", message: e.message });
	}
}

// ---- call (generic Picky MCP tool invocation: list_indexed_agents / rank_agents / get_scorecard) ----
async function cmdCall(args) {
	if (!args.tool) return output({ ok: false, reason: "missing --tool <list_indexed_agents|rank_agents|get_scorecard>" });
	let toolArgs = {};
	if (args.args) {
		try {
			toolArgs = JSON.parse(args.args);
		} catch (e) {
			return output({ ok: false, reason: "invalid_input", details: [`--args is not valid JSON: ${e.message}`] });
		}
	}
	let paymentHeader;
	if (args["payment-header"]) {
		const sep = args["payment-header"].indexOf(":");
		if (sep === -1) return output({ ok: false, reason: "invalid_input", details: ['--payment-header must be "<name>: <value>"'] });
		paymentHeader = { name: args["payment-header"].slice(0, sep).trim(), value: args["payment-header"].slice(sep + 1).trim() };
	}

	try {
		const result = await mcpToolCall(args.tool, toolArgs, paymentHeader);
		output({ ok: true, result });
	} catch (e) {
		if (e instanceof PaymentRequiredError) {
			// Not a failure. This is Step A1 of the OKX Agent Payments Protocol's Path A — hand
			// it off exactly like calling any other paid OKX.AI agent service: pass
			// `payment_required_header` as-is to the okx-agent-payments-protocol skill and let it
			// decode/confirm/pay. Once it returns `{header_name, authorization_header}` from
			// `onchainos payment pay`, retry this same `call` with
			// `--payment-header "<header_name>: <authorization_header>"`.
			return output({
				ok: false,
				payment_required: true,
				payment_required_header: e.paymentRequiredHeader,
				resource: e.resource,
			});
		}
		output({ ok: false, reason: "request_failed", message: e.message });
	}
}

async function main() {
	const [, , command, ...rest] = process.argv;
	const args = parseArgs(rest);
	switch (command) {
		case "check":
			return cmdCheck(args);
		case "notice":
			return cmdNotice();
		case "submit":
			return cmdSubmit(args);
		case "call":
			return cmdCall(args);
		default:
			process.stderr.write(
				"usage: verify.mjs <check|notice|submit|call> [--flags]\nsee skills/okx-picky/SKILL.md for full flag reference\n",
			);
			process.exitCode = 1;
	}
}

main();
