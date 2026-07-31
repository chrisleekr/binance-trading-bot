-- Purge fabricated trade_archive seed rows. A real archived round-trip always
-- records at least one order; an archive row with an empty orders array is a
-- fabricated dev/seed row (source defaults to 'manual'), never a real trade.
-- Safety rests on that writer invariant (both real writers, archive-grid-trade
-- and reconstruct-round-trips, emit >=1 order). The trade-archive isolation
-- test executes this exact file and proves a real manual close and an auto row
-- survive while only the empty-orders row is deleted.
DELETE FROM trade_archive WHERE source = 'manual' AND jsonb_array_length(orders) = 0;
