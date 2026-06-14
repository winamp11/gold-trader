// analyst.js — nightly rulebook analysis for claude_overlay and claude_solo.
// Reads journal win/loss entries joined to trades and signals,
// writes results to analyst_rulebook and analyst_combinations.
// Call runAnalysis(pool) after each trading session closes.

// ── Helpers ───────────────────────────────────────────────────────────────

function adxBucket(adx) {
  if (adx === null || adx === undefined) return 'unknown';
  if (adx < 20) return 'chop';
  if (adx < 35) return 'mild';
  if (adx < 50) return 'trend';
  return 'strong';
}

function rsiBucket(rsi) {
  if (rsi === null || rsi === undefined) return 'unknown';
  if (rsi < 30) return 'oversold';
  if (rsi < 45) return 'bearish';
  if (rsi < 55) return 'neutral';
  if (rsi < 70) return 'bullish';
  return 'overbought';
}

function macdAlignmentScore(signal, direction) {
  const fields = ['h4_macd', 'h1_macd', 'm30_macd', 'm15_macd', 'm5_macd'];
  let score = 0;
  for (const f of fields) {
    const val = signal[f];
    if (val === null || val === undefined) continue;
    if (direction === 'LONG'  && val > 0) score++;
    if (direction === 'SHORT' && val < 0) score++;
  }
  return score;
}

function stopAtrMultiple(trade, signal) {
  const stopDist = Math.abs(trade.entry_price - trade.stop_loss);
  const atr = signal.h1_atr;
  if (!stopDist || !atr) return null;
  return stopDist / atr;
}

function stopAtrBucket(multiple) {
  if (multiple === null || multiple === undefined) return 'unknown';
  if (multiple < 0.8) return 'too_tight';
  if (multiple < 1.2) return 'standard';
  if (multiple < 1.5) return 'wider';
  return 'wide';
}

function rrPlanned(trade) {
  const targetDist = Math.abs(trade.take_profit - trade.entry_price);
  const stopDist   = Math.abs(trade.entry_price  - trade.stop_loss);
  if (!targetDist || !stopDist) return null;
  return targetDist / stopDist;
}

function rangeWidthBucket(ratio) {
  if (ratio === null || ratio === undefined) return 'unknown';
  if (ratio < 0.5) return 'squeeze';
  if (ratio < 1.0) return 'tight';
  if (ratio < 2.0) return 'normal';
  return 'extended';
}

function rangePctBucket(pct) {
  if (pct === null || pct === undefined) return 'unknown';
  if (pct < 25) return 'bottom';
  if (pct < 75) return 'middle';
  return 'top';
}

function sampleConfidence(n) {
  if (n >= 10) return 'sufficient';
  if (n >= 5)  return 'early';
  return 'insufficient';
}

function countBreakdown(rows, keyFn) {
  const groups = {};
  for (const row of rows) {
    const key = keyFn(row) ?? 'unknown';
    if (!groups[key]) groups[key] = { n: 0, wins: 0 };
    groups[key].n++;
    if (row.entry_type === 'win') groups[key].wins++;
  }
  const result = {};
  for (const [k, v] of Object.entries(groups)) {
    result[k] = { n: v.n, wins: v.wins, win_rate: v.wins / v.n };
  }
  return JSON.stringify(result);
}

function avg(values) {
  const valid = values.filter(v => v !== null && v !== undefined && !isNaN(v));
  if (valid.length === 0) return null;
  return valid.reduce((a, b) => a + b, 0) / valid.length;
}

function dominantKey(breakdownJson) {
  try {
    const obj = JSON.parse(breakdownJson);
    let maxKey = null, maxN = 0;
    for (const [k, v] of Object.entries(obj)) {
      if (v.n > maxN) { maxN = v.n; maxKey = k; }
    }
    return maxKey;
  } catch { return null; }
}

// ── Main analysis function ────────────────────────────────────────────────

export async function runAnalysis(pool) {
  const now = new Date().toISOString();
  const twoWeeksAgo = new Date(Date.now() - 14 * 24 * 3600 * 1000).toISOString().slice(0, 10);

  // Step A — Fetch all real win/loss journal entries for solo and overlay
  const { rows } = await pool.query(`
    SELECT
      j.id              AS journal_id,
      j.portfolio_id,
      j.tag,
      j.entry_type,
      j.timestamp       AS journal_timestamp,
      t.id              AS trade_id,
      t.pnl,
      t.exit_reason,
      t.direction,
      t.entry_price,
      t.stop_loss,
      t.take_profit,
      t.session         AS trade_session,
      s.h4_macd, s.h1_macd, s.m30_macd, s.m15_macd, s.m5_macd,
      s.h4_rsi,  s.h1_rsi,  s.m30_rsi,  s.m15_rsi,  s.m5_rsi,
      s.h4_atr,  s.h1_atr,
      s.h4_adx,  s.h1_adx,  s.m30_adx,
      s.session         AS signal_session,
      s.session_high,
      s.session_low,
      s.range_position_pct,
      s.range_width_vs_h1_atr
    FROM journal j
    LEFT JOIN trades  t ON t.id  = j.signal_or_trade_id
    LEFT JOIN signals s ON s.id  = t.signal_id
    WHERE j.portfolio_id IN (2, 3)
      AND j.entry_type IN ('win', 'loss')
      AND t.pnl IS NOT NULL
    ORDER BY j.portfolio_id, j.tag, j.timestamp
  `);

  // Count excluded (window-close / circuit-breaker / expired) per portfolio+tag
  const { rows: excludedRows } = await pool.query(`
    SELECT j.portfolio_id, j.tag, COUNT(*) AS excluded_count
    FROM journal j
    LEFT JOIN trades t ON t.id = j.signal_or_trade_id
    WHERE j.portfolio_id IN (2, 3)
      AND j.entry_type IN ('win', 'loss')
      AND t.exit_reason IN ('WINDOW_CLOSE', 'CIRCUIT_BREAKER', 'EXPIRED')
    GROUP BY j.portfolio_id, j.tag
  `);
  const excludedMap = {};
  for (const r of excludedRows) {
    excludedMap[`${r.portfolio_id}:${r.tag}`] = parseInt(r.excluded_count) || 0;
  }

  // Step B — Account names
  const { rows: portfolios } = await pool.query(
    `SELECT id, name FROM portfolios WHERE id IN (2, 3)`
  );
  const accountNames = {};
  for (const p of portfolios) accountNames[p.id] = p.name;

  // ── Step C — Process analyst_rulebook ────────────────────────────────────
  const groups = {};
  for (const row of rows) {
    const key = `${row.portfolio_id}:${row.tag}`;
    if (!groups[key]) groups[key] = { portfolio_id: row.portfolio_id, tag: row.tag, rows: [] };
    groups[key].rows.push(row);
  }

  // Wipe all existing rulebook rows for these portfolios before reinserting.
  // This is required so renamed/consolidated tags don't leave stale rows behind.
  await pool.query(`DELETE FROM analyst_rulebook WHERE portfolio_id IN (2, 3)`);

  let rulebookRowsWritten = 0;

  for (const { portfolio_id, tag, rows: grp } of Object.values(groups)) {
    const accountName = accountNames[portfolio_id];
    const nTotal  = grp.length;
    const wins    = grp.filter(r => r.entry_type === 'win');
    const losses  = grp.filter(r => r.entry_type === 'loss');
    const nWins   = wins.length;
    const nLosses = losses.length;
    const winRate = nTotal > 0 ? nWins / nTotal : 0;

    const avgWinPnl  = avg(wins.map(r => r.pnl));
    const avgLossPnl = avg(losses.map(r => r.pnl));
    const expectancy = (avgWinPnl != null && avgLossPnl != null)
      ? (winRate * avgWinPnl) + ((1 - winRate) * avgLossPnl)
      : null;

    const longs  = grp.filter(r => r.direction === 'LONG');
    const shorts = grp.filter(r => r.direction === 'SHORT');
    const longN  = longs.length;
    const shortN = shorts.length;
    const longWinRate  = longN  > 0 ? longs.filter(r => r.entry_type  === 'win').length / longN  : null;
    const shortWinRate = shortN > 0 ? shorts.filter(r => r.entry_type === 'win').length / shortN : null;

    const avgH4Adx       = avg(grp.map(r => r.h4_adx));
    const adxBreakdown   = countBreakdown(grp, r => adxBucket(r.h4_adx));
    const dominantAdx    = dominantKey(adxBreakdown);

    const avgH4Rsi     = avg(grp.map(r => r.h4_rsi));
    const rsiBreakdown = countBreakdown(grp, r => rsiBucket(r.h4_rsi));

    const avgMacdAlignment = avg(grp.map(r => macdAlignmentScore(r, r.direction)));

    const sessionBreakdown = countBreakdown(grp, r => r.signal_session || r.trade_session || 'unknown');
    const dominantSession  = dominantKey(sessionBreakdown);

    const avgStopAtrMultiple = avg(grp.map(r => stopAtrMultiple(r, r)));
    const stopAtrBreakdown   = countBreakdown(grp, r => stopAtrBucket(stopAtrMultiple(r, r)));

    const avgRrPlanned = avg(grp.map(r => rrPlanned(r)));

    const avgRangePositionPct = avg(grp.map(r => r.range_position_pct));
    const avgRangeWidthAtr    = avg(grp.map(r => r.range_width_vs_h1_atr));

    const rangeWidthRows = grp.filter(r => r.range_width_vs_h1_atr !== null);
    const squeezeCount   = rangeWidthRows.filter(r => r.range_width_vs_h1_atr < 0.5).length;
    const squeezeTradePct = rangeWidthRows.length > 0
      ? (squeezeCount / rangeWidthRows.length) * 100
      : null;

    const lastTradeDate = grp.map(r => r.journal_timestamp).sort().reverse()[0]?.slice(0, 10) ?? null;
    const recencyFlag   = lastTradeDate && lastTradeDate >= twoWeeksAgo ? 'active' : 'stale';
    const confidence    = sampleConfidence(nTotal);
    const windowCloseExcluded = excludedMap[`${portfolio_id}:${tag}`] || 0;

    await pool.query(`
      INSERT INTO analyst_rulebook (
        portfolio_id, account_name, tag,
        n_total, n_wins, n_losses, win_rate,
        avg_win_pnl, avg_loss_pnl, expectancy,
        long_n, long_win_rate, short_n, short_win_rate,
        avg_h4_adx, dominant_adx_bucket, adx_breakdown,
        avg_h4_rsi, rsi_breakdown,
        avg_macd_alignment,
        session_breakdown, dominant_session,
        avg_stop_atr_multiple, stop_atr_breakdown,
        avg_rr_planned,
        avg_range_position_pct, avg_range_width_atr, squeeze_trade_pct,
        recency_flag, last_trade_date, sample_confidence,
        window_close_excluded, last_updated
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,
        $15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,
        $29,$30,$31,$32,$33
      )
    `, [
      portfolio_id, accountName, tag,
      nTotal, nWins, nLosses, winRate,
      avgWinPnl, avgLossPnl, expectancy,
      longN, longWinRate, shortN, shortWinRate,
      avgH4Adx, dominantAdx, adxBreakdown,
      avgH4Rsi, rsiBreakdown,
      avgMacdAlignment,
      sessionBreakdown, dominantSession,
      avgStopAtrMultiple, stopAtrBreakdown,
      avgRrPlanned,
      avgRangePositionPct, avgRangeWidthAtr, squeezeTradePct,
      recencyFlag, lastTradeDate, confidence,
      windowCloseExcluded, now,
    ]);

    rulebookRowsWritten++;
  }

  // ── Step D — Process analyst_combinations ────────────────────────────────
  const comboGroups = {};
  for (const row of rows) {
    const sess = row.signal_session || row.trade_session || 'unknown';
    const key  = `${row.portfolio_id}:${row.direction}:${adxBucket(row.h4_adx)}:${rsiBucket(row.h4_rsi)}:${sess}`;
    if (!comboGroups[key]) {
      comboGroups[key] = {
        portfolio_id:   row.portfolio_id,
        direction:      row.direction,
        adx_bucket:     adxBucket(row.h4_adx),
        h4_rsi_bucket:  rsiBucket(row.h4_rsi),
        session:        sess,
        rows:           [],
      };
    }
    comboGroups[key].rows.push(row);
  }

  // Delete then re-insert all combination rows for these portfolios
  await pool.query(`DELETE FROM analyst_combinations WHERE portfolio_id IN (2, 3)`);

  let combinationRowsWritten = 0;
  for (const { portfolio_id, direction, adx_bucket, h4_rsi_bucket, session, rows: cRows } of Object.values(comboGroups)) {
    if (cRows.length < 3) continue;

    const accountName = accountNames[portfolio_id];
    const nTotal  = cRows.length;
    const nWins   = cRows.filter(r => r.entry_type === 'win').length;
    const winRate = nTotal > 0 ? nWins / nTotal : 0;
    const avgPnl  = avg(cRows.map(r => r.pnl));

    const cWins   = cRows.filter(r => r.entry_type === 'win');
    const cLosses = cRows.filter(r => r.entry_type === 'loss');
    const avgWinPnlC  = avg(cWins.map(r => r.pnl));
    const avgLossPnlC = avg(cLosses.map(r => r.pnl));
    const expectancy  = (avgWinPnlC != null && avgLossPnlC != null)
      ? (winRate * avgWinPnlC) + ((1 - winRate) * avgLossPnlC)
      : null;
    const confidence = sampleConfidence(nTotal);

    await pool.query(`
      INSERT INTO analyst_combinations (
        portfolio_id, account_name, direction,
        adx_bucket, h4_rsi_bucket, session,
        n_total, n_wins, win_rate,
        avg_pnl, expectancy, sample_confidence, last_updated
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    `, [
      portfolio_id, accountName, direction,
      adx_bucket, h4_rsi_bucket, session,
      nTotal, nWins, winRate,
      avgPnl, expectancy, confidence, now,
    ]);

    combinationRowsWritten++;
  }

  // Step E — Summary
  return {
    rulebook_rows_written:     rulebookRowsWritten,
    combination_rows_written:  combinationRowsWritten,
    portfolios_processed:      [2, 3],
    timestamp:                 now,
  };
}

// ── Prompt formatter (used by GET /api/analyst/rulebook/prompt) ───────────

export function formatRulebookPrompt(rulebookRows, combinationRows) {
  const lines = [];

  for (const r of rulebookRows) {
    const wr    = (r.win_rate   * 100).toFixed(0);
    const exp   = r.expectancy != null ? `${r.expectancy >= 0 ? '+' : ''}$${Math.round(r.expectancy)}` : 'n/a';
    const short = r.short_n ? `${((r.short_win_rate ?? 0) * 100).toFixed(0)}% (${r.short_n})` : '0% (0)';
    const longS = r.long_n  ? `${((r.long_win_rate  ?? 0) * 100).toFixed(0)}% (${r.long_n})`  : '0% (0)';

    // Dominant session win-rate from session_breakdown JSON
    let sessionStr = 'n/a';
    try {
      const sb = JSON.parse(r.session_breakdown);
      const dom = r.dominant_session;
      if (dom && sb[dom]) {
        sessionStr = `${dom.toUpperCase()} ${((sb[dom].win_rate ?? 0) * 100).toFixed(0)}% WR`;
      }
    } catch { /* leave n/a */ }

    // Dominant stop-atr bucket percentage
    let stopStr = 'n/a';
    try {
      const sa = JSON.parse(r.stop_atr_breakdown);
      const dom = r.dominant_adx_bucket; // reuse for dominant stop is wrong; find max in sa
      let maxBucket = null, maxN = 0;
      for (const [k, v] of Object.entries(sa)) {
        if (v.n > maxN) { maxN = v.n; maxBucket = k; }
      }
      if (maxBucket) stopStr = `${maxBucket} ${Math.round((maxN / r.n_total) * 100)}%`;
    } catch { /* leave n/a */ }

    const adxStr   = r.avg_h4_adx         != null ? `${r.dominant_adx_bucket ?? '?'} avg ${Math.round(r.avg_h4_adx)}` : 'n/a';
    const rsiStr   = r.avg_h4_rsi         != null ? `${rsiBucketLabel(r.avg_h4_rsi)} avg ${Math.round(r.avg_h4_rsi)}` : 'n/a';
    const macdStr  = r.avg_macd_alignment  != null ? r.avg_macd_alignment.toFixed(1) + '/5' : 'n/a';
    const rrStr    = r.avg_rr_planned      != null ? r.avg_rr_planned.toFixed(1) + ' avg' : 'n/a';

    lines.push(
      `[${r.account_name.replace('claude_', '')}] ${r.tag} | WIN RATE: ${wr}% over ${r.n_total} trades | EXPECTANCY: ${exp} | ` +
      `SHORT: ${short}, LONG: ${longS} | ADX: ${adxStr} | ` +
      `RSI: ${rsiStr} | MACD align: ${macdStr} | ` +
      `SESSION: ${sessionStr} | STOP: ${stopStr} | RR: ${rrStr} | CONFIDENCE: ${r.sample_confidence}`
    );
  }

  // Cross-account comparison (tags appearing in both solo and overlay)
  const byTag = {};
  for (const r of rulebookRows) {
    if (!byTag[r.tag]) byTag[r.tag] = {};
    byTag[r.tag][r.account_name] = r;
  }
  const crossTags = Object.entries(byTag).filter(([, accts]) =>
    accts['claude_overlay'] && accts['claude_solo']
  );
  if (crossTags.length > 0) {
    lines.push('');
    lines.push('CROSS-ACCOUNT PATTERNS:');
    for (const [tag, accts] of crossTags) {
      const s = accts['claude_solo'];
      const o = accts['claude_overlay'];
      const agree = (s.win_rate >= 0.5) === (o.win_rate >= 0.5) ? 'AGREE' : 'DISAGREE';
      lines.push(
        `[${tag}] solo: ${(s.win_rate * 100).toFixed(0)}% over ${s.n_total} | ` +
        `overlay: ${(o.win_rate * 100).toFixed(0)}% over ${o.n_total} | ${agree}`
      );
    }
  }

  // Top 5 combinations
  if (combinationRows.length > 0) {
    lines.push('');
    lines.push('TOP COMBINATIONS (N>=3):');
    for (const c of combinationRows.slice(0, 5)) {
      const exp = c.expectancy != null ? `expectancy ${c.expectancy >= 0 ? '+' : ''}$${Math.round(c.expectancy)}` : '';
      lines.push(
        `[${c.account_name.replace('claude_', '')}] ${c.direction} + ADX ${c.adx_bucket} + RSI ${c.h4_rsi_bucket}` +
        (c.session && c.session !== 'unknown' ? ` + ${c.session.toUpperCase()}` : '') +
        ` | ${(c.win_rate * 100).toFixed(0)}% over ${c.n_total} | ${exp}`
      );
    }
  }

  return lines.join('\n');
}

function rsiBucketLabel(rsi) {
  if (rsi < 30) return 'oversold';
  if (rsi < 45) return 'bearish';
  if (rsi < 55) return 'neutral';
  if (rsi < 70) return 'bullish';
  return 'overbought';
}
