// claudeClient.js — shared Anthropic client used by both Claude deciders.
// Handles lazy init, prompt-caching headers, response validation,
// lot clamping, daily call counter, and the safe NO_TRADE fallback.

import Anthropic from '@anthropic-ai/sdk';

export const MODEL      = 'claude-sonnet-4-6';
export const MAX_TOKENS = 500;

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

function noTrade(deciderName, reason) {
  return {
    action:    'NO_TRADE',
    direction: null,
    entry:     null,
    stop:      null,
    target:    null,
    lots:      null,
    reasoning: `decision unavailable: ${reason}`,
    tag:       `${deciderName}_error`
  };
}

// ── Main helper — called by each decider ────────────────────────────────
//
// systemPrompt  static text marked for prompt caching
// userContent   dynamic market snapshot + lessons for this cycle
// deciderName   'overlay' | 'solo'  (used in logs)

export async function callDecider({ systemPrompt, userContent, deciderName }) {
  const n = nextCallNum();
  console.log(`🤖 [${deciderName}] Claude call #${n} today`);

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

    // Log token usage for cost visibility
    const u = resp.usage;
    const cacheCreate = u.cache_creation_input_tokens ?? 0;
    const cacheRead   = u.cache_read_input_tokens   ?? 0;
    console.log(
      `📊 [${deciderName}] tokens: in=${u.input_tokens}` +
      ` (cache_create=${cacheCreate} cache_read=${cacheRead})` +
      ` out=${u.output_tokens}`
    );

    const raw = resp.content[0]?.text ?? '';

    // Strip markdown code fences if Claude wrapped the JSON
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('response contained no JSON object');

    let parsed;
    try   { parsed = JSON.parse(match[0]); }
    catch (e) { throw new Error(`JSON.parse failed: ${e.message}`); }

    const err = validateDecision(parsed);
    if (err) throw new Error(err);

    // Clamp lots for any TRADE
    if (parsed.action === 'TRADE') {
      parsed.lots = clampLots(parsed.lots, deciderName);
    }

    // Ensure string fields are present
    if (typeof parsed.tag !== 'string')       parsed.tag       = `${deciderName}_decision`;
    if (typeof parsed.reasoning !== 'string') parsed.reasoning = '(no reasoning provided)';

    console.log(`✅ [${deciderName}] ${parsed.action}${parsed.direction ? ' ' + parsed.direction : ''} | tag=${parsed.tag}`);
    return parsed;

  } catch (err) {
    console.error(`❌ [${deciderName}] ${err.message}`);
    return noTrade(deciderName, err.message);
  }
}
