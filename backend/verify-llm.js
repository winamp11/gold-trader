// verify-llm.js — smoke-tests the configured LLM provider end to end.
//
//   node verify-llm.js                 # uses env config
//   OPENROUTER_MODEL=x/y node verify-llm.js
//
// Sends a realistic decider prompt and reports whether the model returned
// valid, schema-correct JSON — the failure mode that matters when swapping
// to a cheaper model (a model that can't hold the schema silently turns an
// account into permanent NO_TRADE).

import dotenv from 'dotenv';
dotenv.config();

const { callDecider, MODEL } = await import('./deciders/claudeClient.js');

const SYSTEM = `You are a gold (XAU/USD) trading decider.
Respond with a single valid JSON object. No markdown, no text outside the JSON.

{
  "action": "TRADE" | "NO_TRADE" | "VETO",
  "direction": "LONG" | "SHORT" | null,
  "entry": <number or null>,
  "stop": <number or null>,
  "target": <number or null>,
  "lots": <number or null>,
  "reasoning": "<1-2 sentences>",
  "tag": "<snake_case label>"
}

For TRADE all numeric fields must be present:
  LONG: stop < entry < target (strictly)
  SHORT: target < entry < stop (strictly)
For VETO or NO_TRADE set direction/entry/stop/target/lots to null.`;

const USER = `MARKET SNAPSHOT — XAU/USD
Current price: $4050.00
Current session: EUR
Account balance: $100000.00

TIMEFRAMES:
H4 : price=4050.00  RSI=58.2  MACD=4.10/sig=2.90/hist=1.20  ATR=22.0  ADX=31.5
H1 : price=4050.00  RSI=61.4  MACD=2.80/sig=1.60/hist=1.20  ATR=15.0  ADX=28.0
M30: price=4050.00  RSI=59.0  MACD=1.40/sig=0.90/hist=0.50  ATR=9.0   ADX=24.0

PRIMARY ATR: H1=15.0  M30=9.0

OPEN POSITIONS: none
RISK BUDGET: $0 used / $10000 limit

You have a defensible bullish read. Size a LONG with a 1.5x H1 ATR stop and
at least 1.5:1 reward-to-risk, risking 2% of the account.

What is your trading decision for this cycle?`;

const runs = Number(process.argv[2] || 3);
console.log(`\n🔬 Testing model: ${MODEL}  (${runs} runs)\n`);

let ok = 0;
const t0 = Date.now();

for (let i = 1; i <= runs; i++) {
  const d = await callDecider({ systemPrompt: SYSTEM, userContent: USER, deciderName: 'verify' });
  const failed = typeof d.tag === 'string' &&
    /_(parse_failure|validation_error|api_error)$/.test(d.tag);
  if (failed) {
    console.log(`  run ${i}: ❌ ${d.tag} — ${d.reasoning}`);
  } else {
    ok++;
    const geom = d.action === 'TRADE'
      ? ` ${d.direction} entry=${d.entry} stop=${d.stop} target=${d.target} lots=${d.lots}`
      : '';
    console.log(`  run ${i}: ✅ ${d.action}${geom} | tag=${d.tag}`);
  }
}

const secs = ((Date.now() - t0) / 1000 / runs).toFixed(1);
console.log(`\n${ok}/${runs} valid responses · ~${secs}s per call`);
console.log(ok === runs
  ? '✅ Model holds the schema — safe to run.\n'
  : '⚠️  Schema failures detected. Failed calls become NO_TRADE, so the account\n' +
    '    would silently stop trading. Pick a stronger model.\n');
process.exit(ok === runs ? 0 : 1);
