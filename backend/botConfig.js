// botConfig.js — live-editable parameters for the hybrid bot.
//
// Every field is declared once here with its default, bounds, and label.
// That single declaration drives:
//   - server-side clamping (on write AND on read, so a bad row is inert)
//   - the /api/bot-config endpoints
//   - the settings form in the web app
//
// Values are read fresh each cycle, so edits take effect without a redeploy.

export const HYBRID_BOT = 'claude_hybrid';

// group is used by the UI to section the form.
export const CONFIG_SCHEMA = [
  // ── Risk envelope ──────────────────────────────────────────────────────
  { key: 'dailyProfitTargetPct', label: 'Daily profit target',      unit: '%',   def: 2.5,  min: 0.5, max: 20,  step: 0.1, group: 'Risk',
    help: 'Flatten and stop trading for the day once daily profit reaches this.' },
  { key: 'dailyMaxLossPct',      label: 'Daily max loss',           unit: '%',   def: 3.0,  min: 0.5, max: 10,  step: 0.1, group: 'Risk',
    help: 'Halt and flatten for the day at this daily loss.' },
  { key: 'maxOpenPositions',     label: 'Max open positions',       unit: '',    def: 3,    min: 1,   max: 10,  step: 1,   group: 'Risk',
    help: 'Hard cap on simultaneous open positions (pyramiding included).' },
  { key: 'maxTotalRiskPct',      label: 'Max total open risk',      unit: '%',   def: 1.5,  min: 0.1, max: 10,  step: 0.1, group: 'Risk',
    help: 'Combined risk across all open positions. Stacking splits this budget, it does not multiply it.' },
  { key: 'maxRiskPerTradePct',   label: 'Max risk per trade',       unit: '%',   def: 1.0,  min: 0.1, max: 5,   step: 0.1, group: 'Risk',
    help: 'Ceiling for any single position, also bounded by remaining total risk.' },

  // ── Give-back rule ─────────────────────────────────────────────────────
  { key: 'giveBackPct',          label: 'Give-back trigger',        unit: '%',   def: 30,   min: 5,   max: 90,  step: 1,   group: 'Give-back',
    help: 'Flatten when daily profit falls this far below its peak for the day.' },
  { key: 'giveBackArmPct',       label: 'Give-back arms above',     unit: '%',   def: 0.5,  min: 0.1, max: 5,   step: 0.1, group: 'Give-back',
    help: 'Rule stays dormant until daily profit first exceeds this, so it cannot fire on noise.' },

  // ── Entry cadence + stop sizing ────────────────────────────────────────
  { key: 'entryIntervalMin',     label: 'Min minutes between entries', unit: 'min', def: 15, min: 5,  max: 240, step: 5,   group: 'Entries',
    help: 'Throttle between new positions. Cycles run every 5 min.' },
  { key: 'atrMultMin',           label: 'Stop: min ATR multiple',   unit: '×',   def: 0.75, min: 0.25, max: 5,  step: 0.05, group: 'Entries',
    help: 'Lower clamp on the stop distance the model may choose.' },
  { key: 'atrMultMax',           label: 'Stop: max ATR multiple',   unit: '×',   def: 3.0,  min: 0.5, max: 10,  step: 0.05, group: 'Entries',
    help: 'Upper clamp on the stop distance the model may choose.' },

  // ── Forward-rulebook context gates ─────────────────────────────────────
  { key: 'rulebookMinSamples',   label: 'Rulebook: min samples',    unit: '',    def: 100,  min: 10,  max: 2000, step: 10, group: 'Rulebook',
    help: 'A condition bucket is shown to the model as evidence only above this sample count.' },
];

export const DEFAULTS = Object.fromEntries(CONFIG_SCHEMA.map(f => [f.key, f.def]));

// Clamp + coerce an arbitrary object into a valid config. Unknown keys are
// dropped; missing or non-finite values fall back to the default.
export function sanitizeConfig(raw = {}) {
  const out = {};
  for (const f of CONFIG_SCHEMA) {
    const n = Number(raw?.[f.key]);
    out[f.key] = Number.isFinite(n) ? Math.min(f.max, Math.max(f.min, n)) : f.def;
  }
  // Invariants that span fields
  if (out.atrMultMin > out.atrMultMax) {
    const t = out.atrMultMin; out.atrMultMin = out.atrMultMax; out.atrMultMax = t;
  }
  out.maxRiskPerTradePct = Math.min(out.maxRiskPerTradePct, out.maxTotalRiskPct);
  return out;
}

export async function getBotConfig(pool, botName = HYBRID_BOT) {
  try {
    const r = await pool.query('SELECT config FROM bot_config WHERE bot_name = $1', [botName]);
    if (!r.rows[0]) return { ...DEFAULTS };
    return sanitizeConfig(JSON.parse(r.rows[0].config));
  } catch {
    return { ...DEFAULTS };   // unreadable row must never block trading
  }
}

export async function saveBotConfig(pool, config, botName = HYBRID_BOT) {
  const clean = sanitizeConfig(config);
  await pool.query(`
    INSERT INTO bot_config (bot_name, config, updated_at)
    VALUES ($1, $2, $3)
    ON CONFLICT (bot_name) DO UPDATE SET config = $2, updated_at = $3
  `, [botName, JSON.stringify(clean), new Date().toISOString()]);
  return clean;
}
