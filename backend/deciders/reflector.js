// reflector.js — after a position or veto shadow closes, makes a Claude call
// that produces a first-person journal lesson, then writes it to the DB.
//
// Both public functions are fire-and-forget safe: they catch all errors
// internally and never throw — a failed reflection just logs and skips.
// Mechanical positions are silently ignored (no journal for mechanical).

import { callReflector, callBatchReflector } from './claudeClient.js';
import { isForcedExit } from '../exitReasons.js';
import database from '../database.js';
import { TAXONOMY_PROMPT_BLOCK } from '../tagTaxonomy.js';

// ── System prompt (static → prompt-cached) ────────────────────────────────

const REFLECT_SYSTEM = `\
You are writing a first-person trading journal for a gold (XAU/USD) paper-trading account.
After each completed trade or resolved veto, write a short lesson in the trader's voice.

Rules:
- First person ("I went long...", "I vetoed because...", "I was right to avoid...")
- 2–3 sentences maximum
- Be specific: name the setup, the outcome, what to watch for next time
- If this is a recurring mistake, acknowledge it explicitly
- Return ONLY valid JSON — no markdown, no text outside the object

${TAXONOMY_PROMPT_BLOCK}

Output format:
{
  "lesson_text": "<first-person lesson, 2-3 sentences>",
  "tag": "<one tag key from the list above — exact string, no modifications>"
}`;

// ── Helpers ───────────────────────────────────────────────────────────────

// 'daily' (default) → one batched call at 21:15 UAE via reflectDaily()
// 'per_trade'       → legacy behavior, one call per closed trade/veto
const REFLECT_MODE = (process.env.REFLECT_MODE || 'daily').toLowerCase();

function fmt(n, dp = 2) { return n != null ? Number(n).toFixed(dp) : 'n/a'; }

function pnlStr(pnl) {
  if (pnl == null) return 'n/a';
  return `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`;
}

// ── Outcome classification (shared by per-trade and batch paths) ─────────

function classifyOutcome(outcome, pnl) {
  if (outcome === 'TARGET_HIT') return { entryType: 'win',  exitType: 'strategy' };
  if (outcome === 'STOP_HIT')   return { entryType: 'loss', exitType: 'strategy' };
  if (isForcedExit(outcome)) {
    // Forced exits: count as win/loss by P&L sign so the Analyst sees them.
    return { entryType: pnl > 0 ? 'win' : pnl < 0 ? 'loss' : 'observation', exitType: 'forced' };
  }
  return { entryType: 'observation', exitType: null };
}

// ── Daily batch reflection ───────────────────────────────────────────────
// One LLM call per day (21:15 UAE) covering every closed trade and resolved
// veto that has no journal entry yet — replacing ~15 per-trade calls.
// Beyond cost, seeing the whole day at once lets the model spot cross-trade
// patterns ("stopped out three times at the same level") that per-trade
// reflection structurally cannot.
//
// Self-healing: selection is "has no journal row", not "closed today", so a
// failed run is picked up by the next one. Capped per run to bound prompt size.

// Items per run, applied to trades and vetoes separately -- so 8 means up to
// 16 entries and roughly 400 + 16*220 output tokens.
//
// Was 25 (up to 50 items, capped at 8000 tokens), which reliably exceeded the
// 90s LLM timeout once a backlog built up: every attempt failed, and because a
// failed run is deliberately not recorded as done, the scheduler retried it
// every minute. Small batches complete comfortably; a backlog is drained by
// running repeatedly rather than by one large call.
export const BATCH_LIMIT = 8;

// Accounts the reflector writes journal entries for.
//
// claude_solo (3) was removed when solo was disabled on 2026-08-09: it no
// longer trades, so reflecting on its history spends tokens producing lessons
// nothing will ever read. Its existing entries are left untouched. Add the id
// back here if solo is ever resumed.
export const REFLECT_PORTFOLIO_IDS = [2];   // claude_overlay

// Minutes-since-UAE-midnight at which the daily reflection runs. 21:15 UAE,
// 15 minutes after the 21:00 window close, so every position is closed and
// its P&L booked.
export const REFLECT_DEFAULT_MIN = 21 * 60 + 15;

/**
 * Resolve the configured run time, defending against the unit confusion that
 * silently disabled this job.
 *
 * The value is MINUTES SINCE MIDNIGHT, not HHMM. Setting it to "2115" — the
 * obvious thing to write if you read the name as a clock time — produces a
 * threshold that minutes-since-midnight (max 1439) can never reach, so the
 * scheduler returns early forever and the journal simply stops, with no error
 * anywhere. Out-of-range values now fall back to the default and say so.
 */
export function normalizeReflectMin(raw, warn = () => {}) {
  if (raw == null || raw === '') return REFLECT_DEFAULT_MIN;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) {
    warn(`REFLECT_UAE_MIN="${raw}" is not a number — using default ${REFLECT_DEFAULT_MIN}`);
    return REFLECT_DEFAULT_MIN;
  }
  if (n < 0 || n > 1439) {
    warn(
      `REFLECT_UAE_MIN=${n} is outside 0-1439 (minutes since midnight, not HHMM) — ` +
      `using default ${REFLECT_DEFAULT_MIN}. A value like 2115 can never be reached ` +
      `and would disable daily reflection entirely.`
    );
    return REFLECT_DEFAULT_MIN;
  }
  return n;
}

/**
 * Should the daily reflection run right now?
 *
 * Pure so the condition that broke can actually be tested. `lastRunDate` is
 * the last UAE date a run completed, read from persistent storage rather than
 * memory -- an in-memory value resets on every redeploy and cannot tell
 * "already ran today" from "never ran".
 *
 * Two ways to become due:
 *   - the normal one: it is past the scheduled minute and today has no run
 *   - catch-up: the last run predates yesterday, so a whole day was already
 *     missed. Time of day no longer matters -- waiting for the window risks
 *     missing it again, and every missed day is lost work.
 */
export function shouldReflectNow({ lastRunDate, today, yesterday, minsNow, reflectMin }) {
  if (lastRunDate === today) return { due: false, reason: 'already ran today' };
  const missedAFullDay = !lastRunDate || lastRunDate < yesterday;
  if (missedAFullDay) {
    return { due: true, reason: lastRunDate ? `catch-up — last run ${lastRunDate}` : 'catch-up — never run' };
  }
  if (minsNow < reflectMin) return { due: false, reason: 'before the scheduled time' };
  return { due: true, reason: 'scheduled' };
}


const BATCH_SYSTEM = `\
You are writing a first-person trading journal for a gold (XAU/USD) paper-trading account.
You are reviewing a full day of completed trades and resolved vetoes at once.

Rules:
- First person ("I went long...", "I vetoed because...")
- 2–3 sentences per entry, each specific: name the setup, the outcome, what to watch next time
- You can see the whole day — where the same mistake or edge repeats across entries, say so explicitly
- Return ONLY a valid JSON array — no markdown, no text outside the array

${TAXONOMY_PROMPT_BLOCK}

Output format — one object per item you were given, echoing its id exactly:
[
  { "id": <the id given>, "lesson_text": "<first-person lesson, 2-3 sentences>", "tag": "<one tag key from the list above — exact string>" }
]`;

// opts.dryRun — ignore the "not yet journaled" filter and skip all writes.
// Exercises query → prompt → LLM → parse without mutating the journal, so the
// batch path can be verified on a day whose trades are already reflected.
export async function reflectDaily(pool, { dryRun = false, limit = BATCH_LIMIT, portfolioIds = REFLECT_PORTFOLIO_IDS } = {}) {
  try {
    const cap = Math.max(1, Math.min(limit, BATCH_LIMIT));
    const ids = (portfolioIds && portfolioIds.length) ? portfolioIds : REFLECT_PORTFOLIO_IDS;
    const notJournaledTrade = dryRun ? '' : `
        AND NOT EXISTS (
          SELECT 1 FROM journal j
          WHERE j.signal_or_trade_id = t.id
            AND j.portfolio_id = t.portfolio_id
            AND j.entry_type <> 'veto'
        )`;
    const notJournaledShadow = dryRun ? '' : `
        AND NOT EXISTS (
          SELECT 1 FROM journal j
          WHERE j.signal_or_trade_id = v.id
            AND j.portfolio_id = v.portfolio_id
            AND j.entry_type = 'veto'
        )`;
    // Closed trades with no journal entry. NO_ENTRY/EXPIRED are excluded —
    // an unfilled order carries no lesson and the Analyst ignores observations.
    const { rows: trades } = await pool.query(`
      SELECT t.id, t.portfolio_id, p.name AS portfolio_name, t.direction,
             t.entry_price, t.stop_loss, t.take_profit, t.lot_size,
             t.exit_price, t.exit_reason, t.pnl, t.tag, t.reasoning, t.session,
             t.max_price_during, t.min_price_during
      FROM trades t
      JOIN portfolios p ON p.id = t.portfolio_id
      WHERE t.portfolio_id = ANY($1)
        AND t.exit_reason IS NOT NULL
        AND t.exit_reason NOT IN ('NO_ENTRY', 'EXPIRED')${notJournaledTrade}
      ORDER BY t.exit_timestamp DESC
      LIMIT ${cap}
    `, [ids]);

    const { rows: shadows } = await pool.query(`
      SELECT v.id, v.portfolio_id, p.name AS portfolio_name, v.direction,
             v.entry, v.stop, v.target, v.tag, v.reasoning,
             v.would_be_outcome, v.would_be_pnl
      FROM veto_shadows v
      JOIN portfolios p ON p.id = v.portfolio_id
      WHERE v.portfolio_id = ANY($1)
        AND v.would_be_outcome IS NOT NULL${notJournaledShadow}
      ORDER BY v.timestamp DESC
      LIMIT ${cap}
    `, [ids]);

    if (trades.length === 0 && shadows.length === 0) {
      console.log('🪞 [reflectDaily] nothing to reflect on');
      return { trades: 0, vetoes: 0, written: 0 };
    }

    // ids are unique across both sets because trades and shadows are keyed
    // separately; prefix the id in the prompt so the model can't confuse them.
    const lines = [`DAY REVIEW — ${trades.length} completed trade(s), ${shadows.length} resolved veto(es)`, ''];

    for (const t of trades) {
      lines.push(
        `[id ${t.id}] COMPLETED TRADE — ${t.portfolio_name} (${t.session ?? 'n/a'} session)`,
        `  ${t.direction} entry=${fmt(t.entry_price)} stop=${fmt(t.stop_loss)} target=${fmt(t.take_profit)} lots=${fmt(t.lot_size, 2)}`,
        `  Setup tag: ${t.tag ?? 'unknown'} | Original reasoning: "${t.reasoning ?? '(not recorded)'}"`,
        `  Outcome: ${t.exit_reason} @ ${fmt(t.exit_price)} | P&L: ${pnlStr(t.pnl)}`,
        `  Price range while held: low=${fmt(t.min_price_during)} high=${fmt(t.max_price_during)}`,
        ''
      );
    }
    for (const s of shadows) {
      lines.push(
        `[id ${s.id}] RESOLVED VETO — ${s.portfolio_name}`,
        `  I vetoed: ${s.direction} entry=${fmt(s.entry)} stop=${fmt(s.stop)} target=${fmt(s.target)}`,
        `  Veto tag: ${s.tag ?? 'unknown'} | Veto reasoning: "${s.reasoning ?? '(not recorded)'}"`,
        `  Counterfactual outcome: ${s.would_be_outcome} | Would-be P&L: ${pnlStr(s.would_be_pnl)}`,
        `  → The veto was ${s.would_be_pnl < 0 ? 'CORRECT (the trade would have lost)' : s.would_be_pnl > 0 ? 'WRONG (the trade would have won)' : 'neutral (no clear resolution)'}`,
        ''
      );
    }
    lines.push(`Write one journal entry per id above. Return the JSON array only.`);

    const total   = trades.length + shadows.length;
    const lessons = await callBatchReflector({
      systemPrompt: BATCH_SYSTEM,
      userContent:  lines.join('\n'),
      deciderName:  'reflect_daily',
      maxTokens:    Math.min(8000, 400 + total * 220),
    });
    if (!lessons) return { trades: trades.length, vetoes: shadows.length, written: 0, error: 'llm_failed' };

    if (dryRun) {
      console.log(`🧪 [reflectDaily] dry run — ${lessons.length}/${total} lessons returned, nothing written`);
      return {
        dry_run: true, trades: trades.length, vetoes: shadows.length,
        lessons_returned: lessons.length, expected: total,
        matched_ids: lessons.filter(l => [...trades, ...shadows].some(x => x.id === l.id)).length,
        sample: lessons.slice(0, 3),
      };
    }

    const byId = new Map(lessons.map(l => [l.id, l]));
    const touchedPortfolios = new Set();
    let written = 0;

    for (const t of trades) {
      const l = byId.get(t.id);
      if (!l) { console.warn(`⚠️  [reflectDaily] no lesson returned for trade ${t.id}`); continue; }
      const { entryType, exitType } = classifyOutcome(t.exit_reason, t.pnl);
      await database.saveJournalEntry({
        portfolioId:     t.portfolio_id,
        signalOrTradeId: t.id,
        entryType,
        exitType,
        lessonText:      l.lesson_text,
        tag:             l.tag,
        session:         t.session ?? null,
      });
      touchedPortfolios.add(t.portfolio_id);
      written++;
    }

    for (const s of shadows) {
      const l = byId.get(s.id);
      if (!l) { console.warn(`⚠️  [reflectDaily] no lesson returned for shadow ${s.id}`); continue; }
      await database.saveJournalEntry({
        portfolioId:     s.portfolio_id,
        signalOrTradeId: s.id,
        entryType:       'veto',
        lessonText:      l.lesson_text,
        tag:             l.tag,
      });
      touchedPortfolios.add(s.portfolio_id);
      written++;
    }

    for (const pid of touchedPortfolios) await database.updatePinnedLessons(pid);

    console.log(`🪞 [reflectDaily] ${written}/${total} journal entries written (1 LLM call)`);
    return { trades: trades.length, vetoes: shadows.length, written };

  } catch (err) {
    console.error(`❌ [reflectDaily] ${err.message}`);
    return { trades: 0, vetoes: 0, written: 0, error: err.message };
  }
}

// ── Position reflection ───────────────────────────────────────────────────
// Called after a GREEN or RED position finalizes.
// tracking shape: { portfolioName, portfolioId, direction, entryPrice,
//   stopLoss, target, lots, tag, reasoning, outcome, tradeId,
//   maxPrice, minPrice }

export async function reflect(tracking, outcome, pnl) {
  try {
    if (REFLECT_MODE === 'daily') return;   // handled by the 21:15 UAE batch run
    const CLAUDE_ACCOUNTS = ['claude_overlay', 'claude_solo'];
    if (!CLAUDE_ACCOUNTS.includes(tracking.portfolioName)) return;

    const { entryType, exitType } = classifyOutcome(outcome, pnl);

    const userContent = [
      `COMPLETED TRADE — ${tracking.portfolioName}`,
      `Setup: ${tracking.direction ?? 'n/a'}`,
      `Entry: ${fmt(tracking.entryPrice)} | Stop: ${fmt(tracking.stopLoss)} | Target: ${fmt(tracking.target)} | Lots: ${fmt(tracking.lots, 2)}`,
      `Setup tag: ${tracking.tag ?? 'unknown'}`,
      `Original reasoning: "${tracking.reasoning ?? '(not recorded)'}"`,
      ``,
      `Outcome: ${outcome}`,
      `P&L: ${pnlStr(pnl)}`,
      `Price range while open: low=${fmt(tracking.minPrice)} high=${fmt(tracking.maxPrice)}`,
      ``,
      `Write your first-person journal entry.`,
    ].join('\n');

    const lesson = await callReflector({
      systemPrompt: REFLECT_SYSTEM,
      userContent,
      deciderName:  `${tracking.portfolioName}_reflect`,
    });

    if (lesson) {
      await database.saveJournalEntry({
        portfolioId:      tracking.portfolioId,
        signalOrTradeId:  tracking.tradeId ?? null,
        entryType,
        exitType,
        lessonText:       lesson.lesson_text,
        tag:              lesson.tag,
        session:          tracking.session ?? null,
      });
      await database.updatePinnedLessons(tracking.portfolioId);
    }
  } catch (err) {
    console.error(`❌ [reflector] position reflection error: ${err.message}`);
  }
}

// ── Veto shadow reflection ────────────────────────────────────────────────
// Called after a veto shadow resolves.
// shadow shape: { portfolioName, portfolioId, direction, entryPrice,
//   stopLoss, target, lots, tag, reasoning, shadowId }

export async function reflectVeto(shadow, wouldBeOutcome, wouldBePnl) {
  try {
    if (REFLECT_MODE === 'daily') return;   // handled by the 21:15 UAE batch run
    const CLAUDE_ACCOUNTS = ['claude_overlay', 'claude_solo'];
    if (!CLAUDE_ACCOUNTS.includes(shadow.portfolioName)) return;

    const wouldHaveWon  = wouldBePnl != null ? wouldBePnl > 0 : wouldBeOutcome === 'TARGET_HIT';
    const wouldHaveLost = wouldBePnl != null ? wouldBePnl < 0 : wouldBeOutcome === 'STOP_HIT';
    const correctVeto   = wouldHaveLost;
    const entryType     = 'veto';

    const userContent = [
      `VETO OUTCOME — ${shadow.portfolioName}`,
      `I vetoed this trade:`,
      `  Direction: ${shadow.direction ?? 'n/a'}`,
      `  Entry: ${fmt(shadow.entryPrice)} | Stop: ${fmt(shadow.stopLoss)} | Target: ${fmt(shadow.target)}`,
      `  Veto tag: ${shadow.tag ?? 'unknown'}`,
      `  Veto reasoning: "${shadow.reasoning ?? '(not recorded)'}"`,
      ``,
      `Shadow (counterfactual) outcome: ${wouldBeOutcome}`,
      `Would-be P&L: ${pnlStr(wouldBePnl)}`,
      correctVeto
        ? `→ The veto was CORRECT — the trade would have lost.`
        : wouldHaveWon
          ? `→ The veto was WRONG — the trade would have won.`
          : `→ The trade did not trigger or expired without hitting levels.`,
      ``,
      `Write your first-person journal entry reflecting on whether this veto was justified.`,
    ].join('\n');

    const lesson = await callReflector({
      systemPrompt: REFLECT_SYSTEM,
      userContent,
      deciderName:  `${shadow.portfolioName}_veto_reflect`,
    });

    if (lesson) {
      await database.saveJournalEntry({
        portfolioId:      shadow.portfolioId,
        signalOrTradeId:  shadow.shadowId ?? null,
        entryType,
        lessonText:       lesson.lesson_text,
        tag:              lesson.tag,
        session:          shadow.session ?? null,
      });
      await database.updatePinnedLessons(shadow.portfolioId);
    }
  } catch (err) {
    console.error(`❌ [reflector] veto reflection error: ${err.message}`);
  }
}
