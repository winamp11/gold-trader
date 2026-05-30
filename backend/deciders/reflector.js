// reflector.js — after a position or veto shadow closes, makes a Claude call
// that produces a first-person journal lesson, then writes it to the DB.
//
// Both public functions are fire-and-forget safe: they catch all errors
// internally and never throw — a failed reflection just logs and skips.
// Mechanical positions are silently ignored (no journal for mechanical).

import { callReflector } from './claudeClient.js';
import database from '../database.js';

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

Output format:
{
  "lesson_text": "<first-person lesson, 2-3 sentences>",
  "tag": "<snake_case label describing the lesson type>"
}

Tag examples: h1_momentum_conflict_loss, atr_stop_correct_win,
  rsi_overbought_ignored_loss, veto_correct_stop_avoided,
  veto_wrong_target_missed, no_entry_volatile_market, expired_no_follow_through`;

// ── Helpers ───────────────────────────────────────────────────────────────

function fmt(n, dp = 2) { return n != null ? Number(n).toFixed(dp) : 'n/a'; }

function pnlStr(pnl) {
  if (pnl == null) return 'n/a';
  return `${pnl >= 0 ? '+' : ''}$${Math.abs(pnl).toFixed(2)}`;
}

// ── Position reflection ───────────────────────────────────────────────────
// Called after a GREEN or RED position finalizes.
// tracking shape: { portfolioName, portfolioId, direction, entryPrice,
//   stopLoss, target, lots, tag, reasoning, outcome, tradeId,
//   maxPrice, minPrice }

export async function reflect(tracking, outcome, pnl) {
  try {
    const CLAUDE_ACCOUNTS = ['claude_overlay', 'claude_solo'];
    if (!CLAUDE_ACCOUNTS.includes(tracking.portfolioName)) return;

    const isWin  = outcome === 'TARGET_HIT';
    const isLoss = outcome === 'STOP_HIT';
    const entryType = isWin ? 'win' : (isLoss ? 'loss' : 'observation');

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
      database.saveJournalEntry({
        portfolioId:      tracking.portfolioId,
        signalOrTradeId:  tracking.tradeId ?? null,
        entryType,
        lessonText:       lesson.lesson_text,
        tag:              lesson.tag,
      });
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
      database.saveJournalEntry({
        portfolioId:      shadow.portfolioId,
        signalOrTradeId:  shadow.shadowId ?? null,
        entryType,
        lessonText:       lesson.lesson_text,
        tag:              lesson.tag,
      });
    }
  } catch (err) {
    console.error(`❌ [reflector] veto reflection error: ${err.message}`);
  }
}
