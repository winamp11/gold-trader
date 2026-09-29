"""Can TimesFM forecast gold's afternoon — direction or range?

PREREGISTERED. This spec, the scoring code and the pass criteria are
committed before any price data is pulled. Read-only: touches no trading
behaviour and nothing here is deployed.

── RESULT ──────────────────────────────────────────────────────────────────
(not yet run)

── Model ───────────────────────────────────────────────────────────────────
google/timesfm-2.5-200m-pytorch, zero-shot, no fine-tuning, no tuning of any
setting after seeing results. 2.5 was released 15 Sep 2025, so every bar
tested below postdates it. TimesFM 3.0 (Aug 2026) is deliberately NOT used:
its pretraining could include the holdout months, and its weights are
licensed for non-commercial, non-production use only.

── Data ────────────────────────────────────────────────────────────────────
Twelve Data XAU/USD 1h bars, requested with timezone=UTC. UAE = UTC+4.
Days tested: weekdays 2025-10-01 .. 2026-09-25 with complete bars.

── One forecast per day ────────────────────────────────────────────────────
Cutoff 12:00 UAE. Context: the 512 hourly closes ending with the bar that
closes at 12:00 UAE. Horizon: 9 bars, to the 21:00 UAE close. The cutoff is
fixed here; no other hour is tried afterwards.

  c12        close at 12:00 UAE
  c21        close at 21:00 UAE
  move       c21 - c12
  range      max(high) - min(low) over the 9 afternoon bars

── Split (by date: hourly data is serially correlated) ─────────────────────
  DEV       2025-10-01 .. 2026-03-31
  HOLDOUT   2026-04-01 .. 2026-09-25

── Q1 Direction ────────────────────────────────────────────────────────────
Forecast direction = sign(point forecast at h=9 - c12).
Baselines:
  morning    sign(c12 - c06)                 the morning's direction
  yesterday  sign of previous trading day's 12:00 -> 21:00 move
PASS requires ALL of:
  D1  holdout hit rate >= 58%
  D2  holdout hit rate beats BOTH baselines' holdout hit rates
  D3  dev hit rate >= 55% and beats both baselines on dev
  D4  $ proxy (sum of sign(forecast) * move over holdout days) stays > 0
      after removing its 3 best days

── Q2 Range ────────────────────────────────────────────────────────────────
Forecast width = q90 - q10 at h=9. Baseline: H1 ATR(14) at the cutoff.
Measured by Spearman rank correlation with the realised afternoon range.
PASS requires ALL of:
  R1  holdout Spearman(width, range) >= 0.30
  R2  holdout Spearman(width, range) > holdout Spearman(ATR, range)
  R3  R1 and R2 also hold on dev
  R4  R1 and R2 still hold on holdout with the 3 largest-range days removed

Anything less is NOT CONFIRMED. No alternative cutoffs, horizons, context
lengths, quantiles or model versions tried afterwards.
"""
import json
import math
import sys
from datetime import datetime, timedelta, timezone

import numpy as np

CUTOFF_UAE, MORNING_UAE, CLOSE_UAE = 12, 6, 21
CONTEXT, HORIZON = 512, 9
FIRST_DAY, DEV_END, LAST_DAY = "2025-10-01", "2026-03-31", "2026-09-25"
UAE = timezone(timedelta(hours=4))


def load_bars(paths):
    """Twelve Data time_series JSON files -> ascending list of UTC bars, deduped."""
    seen = {}
    for p in paths:
        for v in json.load(open(p))["values"]:
            t = datetime.strptime(v["datetime"], "%Y-%m-%d %H:%M:%S").replace(tzinfo=timezone.utc)
            seen[t] = dict(t=t, o=float(v["open"]), h=float(v["high"]), l=float(v["low"]), c=float(v["close"]))
    return [seen[k] for k in sorted(seen)]


def atr14(bars, i):
    """Simple-mean ATR(14) over the 14 bars ending at index i."""
    if i < 14:
        return None
    trs = [max(bars[k]["h"] - bars[k]["l"], abs(bars[k]["h"] - bars[k - 1]["c"]), abs(bars[k]["l"] - bars[k - 1]["c"]))
           for k in range(i - 13, i + 1)]
    return sum(trs) / 14


def build_days(bars):
    """One record per complete weekday. A bar's timestamp is its OPEN time,
    so the bar closing at 12:00 UAE opens at 11:00 UAE."""
    idx = {b["t"]: i for i, b in enumerate(bars)}
    days = []
    d = datetime.strptime(FIRST_DAY, "%Y-%m-%d").date()
    end = datetime.strptime(LAST_DAY, "%Y-%m-%d").date()
    while d <= end:
        if d.weekday() < 5:
            at = lambda h: datetime(d.year, d.month, d.day, h, tzinfo=UAE).astimezone(timezone.utc)
            i12 = idx.get(at(CUTOFF_UAE - 1))
            i06 = idx.get(at(MORNING_UAE - 1))
            aft = [idx.get(at(h)) for h in range(CUTOFF_UAE, CLOSE_UAE)]
            if i12 is not None and i06 is not None and None not in aft and i12 >= CONTEXT \
                    and aft == list(range(i12 + 1, i12 + 1 + HORIZON)):
                days.append(dict(
                    day=d.isoformat(), i12=i12,
                    c12=bars[i12]["c"], c06=bars[i06]["c"], c21=bars[aft[-1]]["c"],
                    range=max(bars[k]["h"] for k in aft) - min(bars[k]["l"] for k in aft),
                    atr=atr14(bars, i12),
                ))
        d += timedelta(days=1)
    for prev, cur in zip(days, days[1:]):
        cur["yday"] = prev["c21"] - prev["c12"]
    return days[1:]  # first day has no "yesterday"


def forecast(bars, days):
    import timesfm
    import torch
    torch.set_num_threads(4)
    model = timesfm.TimesFM_2p5_200M_torch.from_pretrained("google/timesfm-2.5-200m-pytorch")
    model.compile(timesfm.ForecastConfig(
        max_context=CONTEXT, max_horizon=16, normalize_inputs=True,
        use_continuous_quantile_head=True, fix_quantile_crossing=True))
    closes = np.array([b["c"] for b in bars], dtype=np.float32)
    inputs = [closes[d["i12"] - CONTEXT + 1: d["i12"] + 1] for d in days]
    point, quant = model.forecast(horizon=HORIZON, inputs=inputs)
    for d, p, q in zip(days, point, quant):
        d["f_point"] = float(p[HORIZON - 1])
        d["f_q10"] = float(q[HORIZON - 1][1])   # index 0 is the mean, 1..9 are q10..q90
        d["f_q90"] = float(q[HORIZON - 1][9])
    return days


def sgn(x):
    return (x > 0) - (x < 0)


def hit(days, pred):
    return sum(sgn(pred(d)) == sgn(d["c21"] - d["c12"]) for d in days) / len(days)


def spearman(a, b):
    ra = np.argsort(np.argsort(a)).astype(float)
    rb = np.argsort(np.argsort(b)).astype(float)
    return float(np.corrcoef(ra, rb)[0, 1])


def score(days):
    f = lambda d: d["f_point"] - d["c12"]
    morning = lambda d: d["c12"] - d["c06"]
    yday = lambda d: d["yday"]
    out = {"n": len(days)}
    for name, p in (("model", f), ("morning", morning), ("yesterday", yday)):
        out[f"hit_{name}"] = hit(days, p)
    pnl = sorted((sgn(f(d)) * (d["c21"] - d["c12"]) for d in days), reverse=True)
    out["dir_pnl"] = sum(pnl)
    out["dir_pnl_ex3"] = sum(pnl[3:])
    rng = [d["range"] for d in days]
    out["rho_width"] = spearman([d["f_q90"] - d["f_q10"] for d in days], rng)
    out["rho_atr"] = spearman([d["atr"] for d in days], rng)
    trimmed = sorted(days, key=lambda d: d["range"])[:-3]
    tr = [d["range"] for d in trimmed]
    out["rho_width_ex3"] = spearman([d["f_q90"] - d["f_q10"] for d in trimmed], tr)
    out["rho_atr_ex3"] = spearman([d["atr"] for d in trimmed], tr)
    return out


def verdict(dev, hold):
    beats = lambda s: s["hit_model"] > s["hit_morning"] and s["hit_model"] > s["hit_yesterday"]
    rng_ok = lambda w, a: w >= 0.30 and w > a
    return {
        "D1": hold["hit_model"] >= 0.58,
        "D2": beats(hold),
        "D3": dev["hit_model"] >= 0.55 and beats(dev),
        "D4": hold["dir_pnl_ex3"] > 0,
        "R1": hold["rho_width"] >= 0.30,
        "R2": hold["rho_width"] > hold["rho_atr"],
        "R3": rng_ok(dev["rho_width"], dev["rho_atr"]),
        "R4": rng_ok(hold["rho_width_ex3"], hold["rho_atr_ex3"]),
    }


if __name__ == "__main__":
    bars = load_bars(sys.argv[1:])
    days = forecast(bars, build_days(bars))
    dev = [d for d in days if d["day"] <= DEV_END]
    hold = [d for d in days if d["day"] > DEV_END]
    s_dev, s_hold = score(dev), score(hold)
    v = verdict(s_dev, s_hold)
    print(json.dumps({"dev": s_dev, "holdout": s_hold, "verdict": v,
                      "direction": "CONFIRMED" if all(v[k] for k in ("D1", "D2", "D3", "D4")) else "NOT CONFIRMED",
                      "range": "CONFIRMED" if all(v[k] for k in ("R1", "R2", "R3", "R4")) else "NOT CONFIRMED"},
                     indent=2))
