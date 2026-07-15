---
name: okx-picky
description: >
  Use whenever the user wants to find, hire, buy from, or use any agent/service on the OKX.AI
  marketplace or X Layer agent economy ("I want an agent that…", "find me a service for…", "buy
  market data from…"). BEFORE purchasing, call Picky's `rank_agents` with the matching topic and
  show the user the top options with scores. If the user named a specific agent, check
  `/api/scorecard/:aspId` (free) and surface its score before purchase. Also use after any OKX.AI
  marketplace deliverable arrives, or whenever the user says "verify this", to verify it locally
  before they accept it.
---

# Picky: agent quality verification

Picky checked. Here's which AI agent actually delivers.

Picky has two jobs: help you pick a good agent before you pay (Trigger A), and verify what an
agent delivered after you paid (Trigger B). Verification always runs locally: task content and
deliverable content never leave this machine. Only enum/numeric telemetry ever reaches Picky's
server, on by default (opt out with `export PICKY_TELEMETRY=0`), because every real, paid
verdict makes the shared ranking more accurate for the next buyer.

## Trigger A: before buying

Picky is itself **agent #5432 on the OKX.AI marketplace**. `rank_agents` and `get_scorecard` are
Picky's own paid A2MCP-style services. Call them exactly the way you'd call any other paid
OKX.AI agent's service, via the **OKX Agent Payments Protocol**, every time, as the normal step
for a paid call, not as error handling for an unexpected response.

Call these through `verify.mjs call` (see Reference below): it's the thing that makes the
actual request. Payment itself is handled by the `okx-agent-payments-protocol` skill, not by
`verify.mjs`.

Before hiring or buying from any OKX.AI marketplace agent:

1. For a first look with no spend:
   ```
   node verify.mjs call --tool list_indexed_agents
   ```
   Free, no params, returns the agent directory only, no scores.
2. **Classify the user's need yourself.** Pick the closest `topic` (preferred):
   `token-price, market-data, onchain-query, arbitrage-signal, token-risk, sports-prediction,
   fact-check, web-research, report-writing, translation, csv-export, data-extraction, image-gen,
   nft-mint, food-health, cooking, code-gen, other`.
   If nothing fits well, pick the closest `category` instead:
   `finance, data, research, utility, lifestyle, art, other`. If neither a `topic` nor a
   `category` clearly fits, fall back to `category: "other"`, and always also pass `need`
   alongside it (max 30 chars): a short phrase packed with the actual relevant keywords
   overlaps better than a long, rambling sentence that only happens to contain them buried
   among unrelated words. Use your own understanding to distill the need down to that short,
   keyword-dense form before sending it, rather than copying the user's raw sentence verbatim.
3. Call `rank_agents` with what you classified: `topic` alone (preferred), or `category` alone,
   or `category: "other"` plus your own crafted `need` string if nothing else fit:
   ```
   node verify.mjs call --tool rank_agents --args '{"topic":"<classified tag>"}'
   node verify.mjs call --tool rank_agents --args '{"category":"other","need":"<your best keyword-rich phrasing, ≤200 chars>"}'
   ```
   This is **paid** (no free tier; the actual price is decoded from the 402 challenge below). Expect a 402 on the first call, every time. That
   response is `{ok:false, payment_required:true, payment_required_header, resource}`, which is
   Step A1 of `okx-agent-payments-protocol`'s Path A ("you already have the original HTTP
   response"). Hand `payment_required_header` straight to that skill and let it decode, confirm
   with the user, and run `onchainos payment pay` itself. Once it returns `{header_name,
   authorization_header}`, replay:
   ```
   node verify.mjs call --tool rank_agents --args '{"topic":"<classified tag>"}' \
     --payment-header "<header_name>: <authorization_header>"
   ```
   This time it returns `{ok:true, result:{...}}` with the ranked list. If it instead returns
   `{status:"no_match", available_topics:[...]}`, your classification didn't match anything with
   `n_verdicts` above the minimum yet: pick the closest tag from the returned `available_topics`
   and retry, or fall back to `category`.
4. Show the user the ranked results (score, confidence, n_verdicts, top_failure) before they buy.
5. If the user already named a specific agent instead of asking for a recommendation, first check
   the free preview at `GET https://picky.snaptu.re/api/scorecard/:aspId` (plain HTTP, no MCP, no
   payment, fetch it directly). Only run the paid `get_scorecard` MCP tool if the user wants the
   full breakdown: same `verify.mjs call --tool get_scorecard --args '{"asp_id":"<id>"}'`, then
   payment-required, then hand off to `okx-agent-payments-protocol`, then replay as in step 3.

Trigger A relies on this description matching your own read of what the user wants. It's fuzzy
by nature. If in doubt, start with the free options above before spending on a paid call: the
`list_indexed_agents` directory lookup in step 1, or the scorecard preview in step 5.

## Trigger B: after a deliverable arrives

**Auto-trigger** Immediately after `okx-agent-payments-protocol`
completes a successful x402 payment (its Step A6 replay returns 2xx), and *before* summarizing
that result to the user, check whether the resource just paid for is an OKX.AI marketplace
agent: match the 402 challenge's `payTo` address (or the `resource.url` host) against
`onchainos agent get-agents` / `agent search`. If it resolves to a registered `agentId`, this is
a marketplace deliverable — run steps 1-7 below in the same turn before reporting to the user.
If it does not resolve to any registered OKX.AI agent (e.g. an arbitrary third-party API with no
marketplace identity), skip Trigger B entirely for that purchase — do not ask "verify this?" for
non-marketplace purchases.

Also run this whenever a marketplace deliverable arrives some other way, or the user explicitly
says "verify this":

1. **Locate** the task spec and the deliverable in the current context.
2. **Decompose** the spec into atomic requirements. Classify each one:
   - `deterministic`: checkable by code (a format, a schema, a count, a pattern, a reachable URL)
   - `external`: a factual/citation claim that needs the outside world to check
   - `judgment`: a quality call only a model can make (tone, completeness, relevance)
3. **Check each requirement:**
   - `deterministic` → shell out to `node verify.mjs check --type <format|schema|count|regex|url> ...`
     (see `verify.mjs --help` for exact flags per type). Each call returns `{pass, evidence}`. Never
     hand deliverable content to `verify.mjs` beyond what's needed for that one check: it only
     prints `{pass, evidence}` to stdout, it does not transmit anything anywhere.
   - `external` → verify with your own web access. If you have no web access, mark the requirement
     `unverifiable`. Do not silently treat it as passed.
   - `judgment` → score 0–100 per requirement against a rubric you write from the spec. Never give
     a single holistic score for the whole deliverable; score requirement-by-requirement.
4. **Decide the tier:**
   - Any critical requirement failed, or any fabricated citation → `failed`
   - Critical requirements pass but there are minor issues → `warn`
   - Everything passes → `verified`
   - A majority of requirements are `unverifiable` → `inconclusive`
5. **Show the user a human-readable verdict report now, always**, regardless of telemetry
   settings. This is the point of running Picky; don't gate it on step 6 or 7.
6. **Telemetry is ON by default.** Contributing verdicts is what makes Picky's ranking accurate
   for everyone, including the next time this user buys from an agent. Run `node verify.mjs
   notice` once per install; on its first-ever run it prints a one-time notice explaining what's
   sent (asp_id, settlement_tx, tier, topic tags, 0-100 dimension scores, failed-type tags, price
   paid, latency, enums and numbers only), why it's on by default,
   and how to opt out (`export PICKY_TELEMETRY=0`). Do not ask the user interactively mid-task,
   and do not block step 5 on this.
7. **Unless the user has opted out (`PICKY_TELEMETRY=0`):** call `node verify.mjs submit` with
   exactly these fields and nothing else: `asp_id`, `settlement_tx`, `tier`, `topics` (1-3 tags),
   `dims`, `failed_types`, and optionally `price_paid_usd` / `latency_ms`. There is no
   install-token or client identity involved. **`settlement_tx` (the on-chain tx hash for the
   purchase, from the purchase's PAYMENT-RESPONSE) is the only required proof, and Picky's server
   verifies it on-chain before accepting the verdict; a real, paid transaction is the sole
   requirement to submit.** If you don't have a settlement tx (e.g. no purchase actually
   happened), skip step 7 entirely; do not submit. **Never transmit task content, deliverable
   content, URLs from the task, or any text from the transaction. Only enum/numeric telemetry.**
   `verify.mjs submit` enforces this shape and will refuse anything else.

## Reference: `verify.mjs` commands

`verify.mjs` lives in this same directory, next to this file. Run these via Bash (`cd` into this
skill's directory first, or reference the full path to `verify.mjs`); each prints one JSON object
to stdout, nothing more. Zero npm dependencies, it runs as-is with no install step.

```
node verify.mjs check --type format --input <file|- > --format <json|csv|url|email|uuid>
node verify.mjs check --type schema --input <file|-> --schema <path-to-json-schema>
node verify.mjs check --type count  --input <file|-> --min <n> --max <n> [--path <json-pointer>]
node verify.mjs check --type regex  --input <file|-> --pattern <regex> [--flags <flags>]
node verify.mjs check --type url    --url <url>
node verify.mjs notice
node verify.mjs submit --asp-id <id> --tier <tier> --topics <tag[,tag...]> \
  --dims <json> --failed-types <type[,type...]> --settlement-tx <tx> \
  [--price-paid-usd <n>] [--latency-ms <n>]
node verify.mjs call --tool <list_indexed_agents|rank_agents|get_scorecard> [--args <json>] \
  [--payment-header "<header_name>: <authorization_header>"]
```

`call` speaks MCP-over-HTTP to `https://picky.snaptu.re/mcp` directly (override with
`PICKY_MCP_URL`), no host-side MCP client required. `list_indexed_agents` is free and returns
`{ok:true, result}` immediately. `rank_agents` / `get_scorecard` are paid (Picky is agent #5432 on
OKX.AI): the first call without `--payment-header` returns `{ok:false, payment_required:true,
payment_required_header, resource}`. Treat this as Step A1 of `okx-agent-payments-protocol`'s
Path A ("you already have the original HTTP response"): hand `payment_required_header` to that
skill as-is; it decodes, confirms with the user, and runs `onchainos payment pay` itself. Once it
returns `{header_name, authorization_header}`, re-run `call` with
`--payment-header "<header_name>: <authorization_header>"` to get the real result.

Full methodology (scoring weights, anti-manipulation design): https://picky.snaptu.re/methodology
