// claudeClient.js — shared Anthropic client used by both Claude deciders.
// Handles lazy init, prompt-caching headers, response validation,
// lot clamping, daily call counter, and the safe NO_TRADE fallback.

import Anthropic from '@anthropic-ai/sdk';

export const MODEL      = 'claude-sonnet-4-6';
export const MAX_TOKENS = 1024;  // raised from 500 — preamble prose can consume ~200 tokens before JSON

const LOT_MIN = 0.01;
const LOT_MAX = 1.0;

// Lazy client — instantiated on first call so dotenv has already run.
let _client = null;
function getClient() {
  if (!_client) _client = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });
  return _client;
}

// ── Daily call counter (in-memory, resets at midnight) ──────────────────
const _counter = { date: '', count: 0 };

function nextCallNum() {
  const today = new Date().toISOString().slice(0, 10);
  if (_counter.date !== today) { _counter.date = today; _counter.count = 0; }
  return ++_counter.count;
}

export function todayCallCount() { return _counter.count; }

// ── Last-call token usage (overwritten after every call) ─────────────────
// Sequential calls only; safe because the cycle awaits each decider.
let _lastUsage = null;
export function getLastCallUsage() { return _lastUsage ? { ..._lastUsage } : null; }

// ── Schema validation ───────────────────────────────────────────────────

function validateDecision(obj) {
  const ACTIONS = ['TRADE', 'NO_TRADE', 'VETO'];
  if (!ACTIONS.includes(obj.action))
    return `invalid action "${obj.action}"`;

  if (obj.action !== 'TRADE') return null; // VETO/NO_TRADE need no further checks

  if (!['LONG', 'SHORT'].includes(obj.direction))
    return `invalid direction "${obj.direction}"`;
  for (const f of ['entry', 'stop', 'target', 'lots']) {
    if (typeof obj[f] !== 'number' || !isFinite(obj[f]))
      return `"${f}" must be a finite number (got ${JSON.stringify(obj[f])})`;
  }
  if (obj.direction === 'LONG' && !(obj.stop < obj.entry && obj.entry < obj.target))
    return `LONG geometry invalid: stop=${obj.stop} entry=${obj.entry} target=${obj.target}`;
  if (obj.direction === 'SHORT' && !(obj.target < obj.entry && obj.entry < obj.stop))
    return `SHORT geometry invalid: target=${obj.target} entry=${obj.entry} stop=${obj.stop}`;

  return null;
}

function clampLots(raw, deciderName) {
  const rounded = Math.round(raw * 100) / 100;
  if (rounded < LOT_MIN) {
    console.warn(`⚠️  [${deciderName}] lots ${raw} below min ${LOT_MIN} — clamped to ${LOT_MIN}`);
    return LOT_MIN;
  }
  if (rounded > LOT_MAX) {
    console.warn(`⚠️  [${deciderName}] lots ${raw} above max ${LOT_MAX} — clamped to ${LOT_MAX}`);
    return LOT_MAX;
  }
  return rounded;
}

// ── Safe fallback ────────────────────────────────────────────────────────
// failureType values:
//   'parse_failure'      — response had no JSON, or JSON.parse failed
//   'validation_error'   — JSON parsed but failed schema/geometry checks
//   'api_error'          — network timeout, rate-limit, or SDK error

function noTrade(deciderName, reason, failureType = 'api_error') {
  return {
    action:    'NO_TRADE',
    direction: null,
    entry:     null,
    stop:      null,
    target:    null,
    lots:      null,
    reasoning: `decision unavailable: ${reason}`,
    tag:       `${deciderName}_${failureType}`
  };
}

// ── Main helper — called by each decider ────────────────────────────────
//
// systemPrompt  static text marked for prompt caching
// userContent   dynamic market snapshot + lessons for this cycle
// deciderName   'overlay' | 'solo'  (used in logs)

// ── Reflection call — returns { lesson_text, tag } or null ─────────────
// Shares the same client, counter, and last-usage tracker as callDecider
// but validates for { lesson_text, tag } instead of a trading decision.

export async function callReflector({ systemPrompt, userContent, deciderName }) {
  const n = nextCallNum();
  console.log(`🪞 [${deciderName}] reflection call #${n} today`);

  try {
    const resp = await getClient().messages.create(
      {
        model:      MODEL,
        max_tokens: 300,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{ role: 'user', content: userContent }]
      },
      { timeout: 30_000 }
    );

    const u = resp.usage;
    const cacheCreate = u.cache_creation_input_tokens ?? 0;
    const cacheRead   = u.cache_read_input_tokens   ?? 0;
    _lastUsage = { input: u.input_tokens, cache_create: cacheCreate, cache_read: cacheRead, output: u.output_tokens };
    console.log(
      `📊 [${deciderName}] tokens: in=${u.input_tokens}` +
      ` (cache_create=${cacheCreate} cache_read=${cacheRead}) out=${u.output_tokens}`
    );

    const raw   = resp.content[0]?.text ?? '';
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('no JSON in reflection response');

    let parsed;
    try   { parsed = JSON.parse(match[0]); }
    catch (e) { throw new Error(`JSON.parse failed: ${e.message}`); }

    if (typeof parsed.lesson_text !== 'string' || !parsed.lesson_text.trim())
      throw new Error('lesson_text missing or empty');
    if (typeof parsed.tag !== 'string' || !parsed.tag.trim())
      throw new Error('tag missing or empty');

    const result = { lesson_text: parsed.lesson_text.trim(), tag: parsed.tag.trim() };
    console.log(`✅ [${deciderName}] lesson saved | tag=${result.tag}`);
    return result;

  } catch (err) {
    console.error(`❌ [${deciderName}] reflection failed: ${err.message}`);
    return null; // safe fallback — caller skips journal write
  }
}

export async function callDecider({ systemPrompt, userContent, deciderName }) {
  const n = nextCallNum();
  console.log(`🤖 [${deciderName}] Claude call #${n} today`);

  // Tracks which stage we reached — determines the noTrade tag on failure.
  // Starts as 'api_error'; updated as we pass each parsing stage.
  let failureType = 'api_error';

  try {
    const resp = await getClient().messages.create(
      {
        model:      MODEL,
        max_tokens: MAX_TOKENS,
        system: [
          { type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }
        ],
        messages: [{ role: 'user', content: userContent }]
      },
      { timeout: 30_000 }
    );

    const u = resp.usage;
    const cacheCreate = u.cache_creation_input_tokens ?? 0;
    const cacheRead   = u.cache_read_input_tokens   ?? 0;
    _lastUsage = { input: u.input_tokens, cache_create: cacheCreate, cache_read: cacheRead, output: u.output_tokens };
    console.log(
      `📊 [${deciderName}] tokens: in=${u.input_tokens}` +
      ` (cache_create=${cacheCreate} cache_read=${cacheRead})` +
      ` out=${u.output_tokens}`
    );

    const raw = resp.content[0]?.text ?? '';

    // Any failure from here is a content/parse problem, not an API problem.
    failureType = 'parse_failure';

    // Extract the first {...} block — handles markdown fences and prose preambles.
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      console.error(`❌ [${deciderName}] no JSON object found in response. Raw text (${raw.length} chars):\n─────\n${raw}\n─────`);
      throw new Error('response contained no JSON object');
    }

    let parsed;
    try   { parsed = JSON.parse(match[0]); }
    catch (e) {
      console.error(`❌ [${deciderName}] JSON.parse failed. Raw text (${raw.length} chars):\n─────\n${raw}\n─────`);
      throw new Error(`JSON.parse failed: ${e.message}`);
    }

    // Schema/geometry validation failures are distinct from parse failures.
    failureType = 'validation_error';
    const err = validateDecision(parsed);
    if (err) {
      console.error(`❌ [${deciderName}] validation failed: ${err}. Parsed object: ${JSON.stringify(parsed)}`);
      throw new Error(err);
    }

    if (parsed.action === 'TRADE') {
      parsed.lots = clampLots(parsed.lots, deciderName);
    }

    if (typeof parsed.tag !== 'string')       parsed.tag       = `${deciderName}_decision`;
    if (typeof parsed.reasoning !== 'string') parsed.reasoning = '(no reasoning provided)';

    console.log(`✅ [${deciderName}] ${parsed.action}${parsed.direction ? ' ' + parsed.direction : ''} | tag=${parsed.tag}`);
    return parsed;

  } catch (err) {
    console.error(`❌ [${deciderName}] ${err.message}`);
    return noTrade(deciderName, err.message, failureType);
  }
}
