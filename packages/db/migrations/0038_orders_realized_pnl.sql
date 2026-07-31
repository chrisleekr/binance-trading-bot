-- Cost-basis accounting for the trade archive. The archive used to compute
-- realised P/L as a per-window cashflow difference (sum of SELL proceeds minus
-- sum of BUY proceeds over the orders closed since the last archive). That is
-- not accounting: it has no concept of a position's cost basis, so selling an
-- adopted position (held base the bot never bought through an order row) booked
-- the full proceeds as profit, and a hold spanning an archive boundary split
-- wrong on both sides.
--
-- These two columns carry the cost-basis-matched realised P/L of a SELL fill,
-- computed once by the fill-adopter from the position's avg entry price at the
-- instant of the fill. The archive aggregator sums them instead of differencing
-- cashflow. Both are NULL on BUY rows and on a SELL with no known cost basis;
-- the aggregator never substitutes 0 cost for an un-costed sell.
alter table orders add column if not exists realized_pnl numeric;
alter table orders add column if not exists cost_basis_quote numeric;
