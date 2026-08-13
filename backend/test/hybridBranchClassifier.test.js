// Covers the spec's required scenarios 1-8 plus risk caps. Pure unit tests —
// no DB, no network, no LLM call. Run with: node --test test/
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyRulebookQualification, classifyOverlayStatus, classifyBranch, clampRiskUsd,
} from '../hybridBranchClassifier.js';

const CFG = { rulebookMinSamples: 100, rulebookMinDays: 10 };

// n_days is part of every fixture now: a bucket must span enough distinct
// trading days, not just enough rows. Observations inside one day share a
// market and overlapping 4h forward windows, so n_total alone overstates the
// evidence by roughly the number of signals generated per day.
const qualifiedLongBucket  = { n_total: 200, n_days: 25, avg_fwd_4h: 8,  pct_up_4h: 65 };
const qualifiedShortBucket = { n_total: 200, n_days: 25, avg_fwd_4h: -9, pct_up_4h: 30 };
const thinBucket           = { n_total: 20,  n_days: 25, avg_fwd_4h: 8,  pct_up_4h: 65 };
const flatBucket           = { n_total: 300, n_days: 25, avg_fwd_4h: 1,  pct_up_4h: 51 };
// Modelled on the real EUR/strong/bullish: plenty of rows, three days, all of
// them inside one confirmed UP regime.
const fewDaysBucket        = { n_total: 151, n_days: 3,  avg_fwd_4h: 11.5, pct_up_4h: 84 };
const legacyBucket         = { n_total: 200, avg_fwd_4h: 8,  pct_up_4h: 65 };  // no n_days

describe('classifyRulebookQualification', () => {
  test('qualifies a large, directionally consistent LONG bucket', () => {
    const r = classifyRulebookQualification(qualifiedLongBucket, CFG);
    assert.equal(r.qualified, true);
    assert.equal(r.direction, 'LONG');
  });
  test('qualifies a large, directionally consistent SHORT bucket', () => {
    const r = classifyRulebookQualification(qualifiedShortBucket, CFG);
    assert.equal(r.qualified, true);
    assert.equal(r.direction, 'SHORT');
  });
  test('rejects a bucket below the sample floor', () => {
    const r = classifyRulebookQualification(thinBucket, CFG);
    assert.equal(r.qualified, false);
  });
  test('rejects a large but directionally flat bucket', () => {
    const r = classifyRulebookQualification(flatBucket, CFG);
    assert.equal(r.qualified, false);
  });
  test('handles a missing bucket without throwing', () => {
    const r = classifyRulebookQualification(null, CFG);
    assert.equal(r.qualified, false);
    assert.equal(r.direction, null);
  });

  test('rejects a bucket with plenty of rows but too few distinct days', () => {
    // The case that prompted this rule. EUR/strong/bullish held 151
    // observations drawn entirely from Aug 10-12, every one inside the
    // confirmed UP regime, and would have told hybrid to go LONG on the
    // strength of the rally it was sitting in.
    const r = classifyRulebookQualification(fewDaysBucket, CFG);
    assert.equal(r.qualified, false, 'three days must never qualify');
    assert.equal(r.direction, null);
    assert.match(r.reason, /3 distinct day/);
  });

  test('a bucket with no n_days is treated as failing, not passing', () => {
    // Rows written before the column existed have never been day-counted.
    // Defaulting them to "pass" would let every legacy bucket act
    // unchecked for exactly as long as it takes the nightly rebuild to run.
    const r = classifyRulebookQualification(legacyBucket, CFG);
    assert.equal(r.qualified, false);
    assert.match(r.reason, /n_days/);
  });

  test('the day floor is configurable and honoured', () => {
    const bucket = { n_total: 200, n_days: 6, avg_fwd_4h: 8, pct_up_4h: 65 };
    assert.equal(classifyRulebookQualification(bucket, { ...CFG, rulebookMinDays: 10 }).qualified, false);
    assert.equal(classifyRulebookQualification(bucket, { ...CFG, rulebookMinDays: 5 }).qualified, true);
  });

  test('both floors must pass, not either', () => {
    assert.equal(classifyRulebookQualification(
      { n_total: 50, n_days: 40, avg_fwd_4h: 8, pct_up_4h: 65 }, CFG).qualified, false, 'days alone');
    assert.equal(classifyRulebookQualification(
      { n_total: 500, n_days: 2, avg_fwd_4h: 8, pct_up_4h: 65 }, CFG).qualified, false, 'rows alone');
  });
});

describe('classifyOverlayStatus', () => {
  test('supportive: overlay trades the same direction as the rulebook', () => {
    const r = classifyOverlayStatus({ action: 'TRADE', direction: 'LONG' }, 'LONG', null);
    assert.equal(r.status, 'supportive');
  });
  test('REGRESSION: supportive when the rulebook has no qualified direction at all (overlay_only case)', () => {
    // Bug found in production: this exact case (rulebookDirection === null,
    // overlay proposes a real trade) was silently falling through to
    // 'silent' because the old supportive-check required a rulebook
    // direction to exist before it could ever fire -- making overlay_only
    // structurally unreachable, since it's specifically the branch where
    // the rulebook DOESN'T qualify. 195/195 live evaluations landed in
    // no_support before this was caught.
    const r = classifyOverlayStatus({ action: 'TRADE', direction: 'SHORT' }, null, null);
    assert.equal(r.status, 'supportive');
    assert.equal(r.opposingTrade, false);
  });
  test('silent: overlay has no proposal at all', () => {
    const r = classifyOverlayStatus({ action: 'NO_TRADE', tag: 'overlay_no_proposal' }, 'LONG', null);
    assert.equal(r.status, 'silent');
  });
  test('silent: overlay NO_TRADE and mechanical agreed with the rulebook anyway', () => {
    const r = classifyOverlayStatus({ action: 'NO_TRADE' }, 'LONG', { action: 'TRADE', direction: 'LONG' });
    assert.equal(r.status, 'silent');
  });
  test('weakly_opposed: overlay passes on a mechanical proposal opposite the rulebook', () => {
    const r = classifyOverlayStatus({ action: 'NO_TRADE' }, 'LONG', { action: 'TRADE', direction: 'SHORT' });
    assert.equal(r.status, 'weakly_opposed');
    assert.equal(r.opposingTrade, false);
  });
  test('strongly_opposed (directional): overlay vetoes with no execution-risk language', () => {
    const r = classifyOverlayStatus({ action: 'VETO', reasoning: 'H1 RSI extreme against direction', tag: 'divergence_veto' }, 'LONG', null);
    assert.equal(r.status, 'strongly_opposed');
    assert.equal(r.oppositionType, 'directional');
    assert.equal(r.opposingTrade, false);
  });
  test('strongly_opposed (execution_risk): overlay vetoes citing volatility/news', () => {
    const r = classifyOverlayStatus({ action: 'VETO', reasoning: 'ATR exploding, news-shock conditions', tag: 'news_shock_veto' }, 'LONG', null);
    assert.equal(r.status, 'strongly_opposed');
    assert.equal(r.oppositionType, 'execution_risk');
  });
  test('strongly_opposed + opposingTrade: overlay proposes a real trade opposite the rulebook', () => {
    const r = classifyOverlayStatus({ action: 'TRADE', direction: 'SHORT' }, 'LONG', null);
    assert.equal(r.status, 'strongly_opposed');
    assert.equal(r.opposingTrade, true);
  });
});

describe('end-to-end: classifyOverlayStatus -> classifyBranch chained together', () => {
  // The branch-level tests below pass overlayStatus directly, which is what
  // let the production bug slip through unit tests: classifyBranch alone
  // was always correct, but the two functions disagreed about what
  // "supportive with no rulebook direction" meant. These tests run the real
  // pipeline the executor actually calls, end to end.
  test('overlay_only is reachable when the rulebook is unqualified and overlay proposes a real trade', () => {
    const { qualified, direction: rulebookDirection } = classifyRulebookQualification(thinBucket, CFG);
    const overlay = classifyOverlayStatus({ action: 'TRADE', direction: 'LONG' }, rulebookDirection, null);
    const { branch } = classifyBranch({ rulebookQualified: qualified, overlayStatus: overlay.status, overlayOpposingTrade: overlay.opposingTrade });
    assert.equal(branch, 'overlay_only');
  });
  test('agreement is reachable when the rulebook qualifies and overlay agrees', () => {
    const { qualified, direction: rulebookDirection } = classifyRulebookQualification(qualifiedLongBucket, CFG);
    const overlay = classifyOverlayStatus({ action: 'TRADE', direction: 'LONG' }, rulebookDirection, null);
    const { branch } = classifyBranch({ rulebookQualified: qualified, overlayStatus: overlay.status, overlayOpposingTrade: overlay.opposingTrade });
    assert.equal(branch, 'agreement');
  });
  test('rulebook_only_overlay_silent is reachable when the rulebook qualifies and overlay has nothing', () => {
    const { qualified, direction: rulebookDirection } = classifyRulebookQualification(qualifiedShortBucket, CFG);
    const overlay = classifyOverlayStatus({ action: 'NO_TRADE', tag: 'overlay_no_proposal' }, rulebookDirection, null);
    const { branch } = classifyBranch({ rulebookQualified: qualified, overlayStatus: overlay.status, overlayOpposingTrade: overlay.opposingTrade });
    assert.equal(branch, 'rulebook_only_overlay_silent');
  });
});

describe('classifyBranch — the six stable names, and which need the LLM', () => {
  test('1. strong agreement -> agreement, LLM needed', () => {
    const r = classifyBranch({ rulebookQualified: true, overlayStatus: 'supportive', overlayOpposingTrade: false });
    assert.equal(r.branch, 'agreement');
    assert.equal(r.llmNeeded, true);
  });
  test('2. overlay silent, strong rulebook -> rulebook_only_overlay_silent, LLM needed', () => {
    const r = classifyBranch({ rulebookQualified: true, overlayStatus: 'silent', overlayOpposingTrade: false });
    assert.equal(r.branch, 'rulebook_only_overlay_silent');
    assert.equal(r.llmNeeded, true);
  });
  test('3. weak overlay opposition, strong rulebook -> rulebook_only_overlay_opposed, deterministic NO_TRADE', () => {
    const r = classifyBranch({ rulebookQualified: true, overlayStatus: 'weakly_opposed', overlayOpposingTrade: false });
    assert.equal(r.branch, 'rulebook_only_overlay_opposed');
    assert.equal(r.llmNeeded, false);
  });
  test('4. strong overlay opposition (veto, no competing trade) -> rulebook_only_overlay_opposed', () => {
    const r = classifyBranch({ rulebookQualified: true, overlayStatus: 'strongly_opposed', overlayOpposingTrade: false });
    assert.equal(r.branch, 'rulebook_only_overlay_opposed');
    assert.equal(r.llmNeeded, false);
  });
  test('5. execution-risk opposition also routes to rulebook_only_overlay_opposed (deterministic either way)', () => {
    // oppositionType doesn't change branch routing -- both weak and strong
    // opposition resolve to NO_TRADE "for now", per spec.
    const r = classifyBranch({ rulebookQualified: true, overlayStatus: 'strongly_opposed', overlayOpposingTrade: false });
    assert.equal(r.branch, 'rulebook_only_overlay_opposed');
  });
  test('6. overlay-only trade -> overlay_only, LLM needed', () => {
    const r = classifyBranch({ rulebookQualified: false, overlayStatus: 'supportive', overlayOpposingTrade: false });
    assert.equal(r.branch, 'overlay_only');
    assert.equal(r.llmNeeded, true);
  });
  test('7. strong contradiction: qualified rulebook AND overlay proposes a real opposing trade', () => {
    const r = classifyBranch({ rulebookQualified: true, overlayStatus: 'strongly_opposed', overlayOpposingTrade: true });
    assert.equal(r.branch, 'strong_contradiction');
    assert.equal(r.llmNeeded, false);
  });
  test('8. neither source supports a trade -> no_support', () => {
    const r = classifyBranch({ rulebookQualified: false, overlayStatus: 'silent', overlayOpposingTrade: false });
    assert.equal(r.branch, 'no_support');
    assert.equal(r.llmNeeded, false);
  });
  test('no_support also covers an unqualified rulebook with overlay opposition and nothing to contradict', () => {
    const r = classifyBranch({ rulebookQualified: false, overlayStatus: 'weakly_opposed', overlayOpposingTrade: false });
    assert.equal(r.branch, 'no_support');
  });
});

describe('risk caps (clampRiskUsd)', () => {
  test('never exceeds the requested amount', () => {
    assert.equal(clampRiskUsd(200, 1000, 1000), 200);
  });
  test('never exceeds the remaining shared risk budget', () => {
    assert.equal(clampRiskUsd(500, 150, 1000), 150);
  });
  test('never exceeds the per-trade cap', () => {
    assert.equal(clampRiskUsd(500, 1000, 300), 300);
  });
  test('takes the tightest of all three limits simultaneously', () => {
    assert.equal(clampRiskUsd(9999, 400, 250), 250);
  });
  test('a non-numeric request is treated as zero, not NaN', () => {
    assert.equal(clampRiskUsd(undefined, 500, 500), 0);
    assert.equal(clampRiskUsd(null, 500, 500), 0);
  });
});
