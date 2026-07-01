// XAU/USD verified contract specification — single source of truth.
// Used by both position sizing (signalEngine, Claude prompts) and
// P&L booking (outcomeTracker) so they can never diverge.
//
// Broker-verified: 1 standard lot = 100 troy oz.
// P&L = price_move_USD × lots × VALUE_PER_LOT
// Example: 0.50 lots, +$20 price move → +$20 × 0.50 × 100 = +$1,000
//          0.50 lots, −$10 price move → −$10 × 0.50 × 100 = −$500
export const VALUE_PER_LOT = 100; // USD P&L per $1 price move per 1.0 standard lot

// Round-trip transaction cost in price points (spread paid once per trade).
// Typical retail XAU/USD spread is $0.20–0.40; 0.30 is a fair midpoint.
// Charged at position close: cost = SPREAD_POINTS × VALUE_PER_LOT × lots.
// Applied to veto shadows too, so counterfactual P&L stays comparable.
export const SPREAD_POINTS = 0.30;
