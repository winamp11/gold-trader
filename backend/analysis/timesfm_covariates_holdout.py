"""TimesFM with dollar and yield covariates — does outside information help?

PREREGISTERED follow-up to timesfm_holdout.py (NOT CONFIRMED, f2b1d1f).
Spec committed before any covariate data is pulled. Read-only.

── RESULT ──────────────────────────────────────────────────────────────────
(not yet run)

── Why a second test ───────────────────────────────────────────────────────
The first test gave TimesFM only gold's own price. MACD/RSI would add
nothing — they are computed from that same price. Information from OUTSIDE
gold might: the dollar and US yields. This is the only follow-up; if it
fails, TimesFM is closed.

── What changes (and nothing else does) ────────────────────────────────────
Same days, split, cutoff, horizon, context, model, scoring and pass criteria
D1-D4 / R1-R4 as timesfm_holdout.py — imported from it, not copied.

Covariates, as dynamic numerical covariates via forecast_with_covariates
(xreg_mode "xreg + timesfm", ridge 0, library defaults otherwise):

  eurusd   EUR/USD 1h close — dollar proxy. DXY is not on our Twelve Data
           plan; the bots already use EUR/USD for this.
  ief      IEF 1h close (iShares 7-10y Treasury ETF) — yield proxy, moves
           opposite to yields. No US10Y symbol on our plan.

Both are LAGGED BY 9 HOURS: the covariate value at hour t is the close at
t-9 (latest close at or before t-9, carried forward through IEF's closed
hours). The model needs covariate values across the forecast window, and a
9-hour lag is what makes every one of them known at 12:00 UAE. Using
unlagged values would hand the model the afternoon's dollar moves — a leak.

DIRECTION ONLY. The covariate path returns point forecasts, not quantiles,
so it cannot change the range band — Q2 is not re-tested here.
PASS = D1-D4 from the base spec, plus the holdout hit rate must exceed the
no-covariate run's 51.6%.
"""
import json
import sys
from bisect import bisect_right
from datetime import timedelta

import numpy as np

import timesfm_holdout as base

LAG = base.HORIZON
PRIOR_HIT = 0.515625  # no-covariate holdout hit rate


def series(paths):
    bars = base.load_bars(paths)
    return [b["t"] for b in bars], [b["c"] for b in bars]


def lagged(ts, vals, when):
    """Latest value at or before when - LAG hours."""
    i = bisect_right(ts, when - timedelta(hours=LAG)) - 1
    return vals[i] if i >= 0 else None


def forecast_cov(bars, days, cov):
    import timesfm
    import torch
    torch.set_num_threads(4)
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
    model.compile(timesfm.ForecastConfig(
        max_context=base.CONTEXT, max_horizon=16, normalize_inputs=True,
        use_continuous_quantile_head=True, fix_quantile_crossing=True,
        return_backcast=True))
    closes = [b["c"] for b in bars]
    inputs, dyn, kept = [], {k: [] for k in cov}, []
    for d in days:
        lo, hi = d["i12"] - base.CONTEXT + 1, d["i12"] + base.HORIZON + 1
        hours = [bars[k]["t"] for k in range(lo, hi)]
        cols = {k: [lagged(ts, vs, h) for h in hours] for k, (ts, vs) in cov.items()}
        if any(None in c for c in cols.values()):
            continue
        inputs.append(np.array(closes[lo:d["i12"] + 1], dtype=np.float32))
        for k in cov:
            dyn[k].append(cols[k])
        kept.append(d)
    out, _ = model.forecast_with_covariates(inputs=inputs, dynamic_numerical_covariates=dyn)
    for d, o in zip(kept, out):
        d["f_point"] = float(np.asarray(o)[base.HORIZON - 1])
        d["f_q10"] = d["f_q90"] = d["f_point"]  # unused: range not tested here
    return kept


if __name__ == "__main__":
    # argv: gold files..., --eurusd files..., --ief files...
    args, groups, key = sys.argv[1:], {"gold": []}, "gold"
    for a in args:
        if a.startswith("--"):
            key = a[2:]; groups[key] = []
        else:
            groups[key].append(a)
    bars = base.load_bars(groups["gold"])
    cov = {k: series(groups[k]) for k in ("eurusd", "ief")}
    days = forecast_cov(bars, base.build_days(bars), cov)
    dev = [d for d in days if d["day"] <= base.DEV_END]
    hold = [d for d in days if d["day"] > base.DEV_END]
    s_dev, s_hold = base.score(dev), base.score(hold)
    keys = ("n", "hit_model", "hit_morning", "hit_yesterday", "dir_pnl", "dir_pnl_ex3")
    s_dev = {k: s_dev[k] for k in keys}
    s_hold = {k: s_hold[k] for k in keys}
    v = {k: base.verdict(base.score(dev), base.score(hold))[k] for k in ("D1", "D2", "D3", "D4")}
    v["beats_plain"] = s_hold["hit_model"] > PRIOR_HIT
    print(json.dumps({"dev": s_dev, "holdout": s_hold, "verdict": v,
                      "direction": "CONFIRMED" if all(v.values()) else "NOT CONFIRMED"}, indent=2))
