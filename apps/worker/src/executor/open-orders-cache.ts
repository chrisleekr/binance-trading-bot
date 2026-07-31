import type { Redis } from 'ioredis';
import type { OpenOrder } from '@app/strategy-core';

// Long safety ceiling for the account-domain open-orders snapshot. Freshness is
// event-driven — the executor mutates the list on place/cancel and the user-data
// stream mutates it on every execution report — so this TTL only bounds a QUIET
// symbol plus a dropped WS signal (a reconnect gap), with the orphan-detect cron
// as the final backstop. It is refreshed on every mutation, so an actively traded
// key never expires mid-flight.
export const OPEN_ORDERS_TTL_S = 600;

// Lock-free read-modify-write for the cached open-orders list, done server-side
// in one atomic EVAL so a tick cold-load, an executor place/cancel, and a
// user-stream fill can mutate the same key across replicas without clobbering
// each other. No owner, no release token: this is not a lock, it is an atomic
// patch. `remove` / `patch` on an ABSENT key are no-ops (they never fabricate a
// list) — the next tick cold-loads it once. TTL is refreshed on every write.
//
//   KEYS[1] = open-orders key
//   ARGV[1] = op ('upsert' | 'remove' | 'patch'); ARGV[#ARGV] = ttl seconds
//     upsert: ARGV[2]=order JSON
//     remove: ARGV[2]=orderId
//     patch:  ARGV[2]=orderId, ARGV[3]=executedQty, ARGV[4]=cumQuote, ARGV[5]=status
const OPEN_ORDERS_LUA = `
local op = ARGV[1]
local ttl = tonumber(ARGV[#ARGV])
local existing = redis.call('GET', KEYS[1])

local list = {}
if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if ok and type(decoded) == 'table' then list = decoded end
end

local function store(items)
  local encoded = (#items == 0) and '[]' or cjson.encode(items)
  redis.call('SET', KEYS[1], encoded, 'EX', ttl)
  return #items
end

if op == 'upsert' then
  local order = cjson.decode(ARGV[2])
  local replaced = false
  for i = 1, #list do
    if list[i].orderId == order.orderId then list[i] = order; replaced = true; break end
  end
  if not replaced then list[#list + 1] = order end
  return store(list)
end

-- remove / patch never create an absent key: a missing snapshot must cold-load,
-- not be fabricated from a single event.
if not existing then return 0 end

if op == 'remove' then
  local target = tonumber(ARGV[2])
  local out = {}
  for i = 1, #list do
    if list[i].orderId ~= target then out[#out + 1] = list[i] end
  end
  return store(out)
end

if op == 'patch' then
  local target = tonumber(ARGV[2])
  for i = 1, #list do
    if list[i].orderId == target then
      list[i].executedQty = ARGV[3]
      list[i].cummulativeQuoteQty = ARGV[4]
      list[i].status = ARGV[5]
      break
    end
  end
  return store(list)
end

return redis.error_reply('open-orders: unknown op ' .. tostring(op))
`;

/** Insert-or-replace `order` (by orderId) into the cached list; creates the key if absent. */
export const upsertOpenOrder = (
  redis: Redis,
  key: string,
  order: OpenOrder,
  ttlSeconds: number = OPEN_ORDERS_TTL_S,
): Promise<unknown> =>
  redis.eval(OPEN_ORDERS_LUA, 1, key, 'upsert', JSON.stringify(order), String(ttlSeconds));

/** Drop the order with `orderId` from the cached list; no-op if the key is absent. */
export const removeOpenOrder = (
  redis: Redis,
  key: string,
  orderId: number,
  ttlSeconds: number = OPEN_ORDERS_TTL_S,
): Promise<unknown> =>
  redis.eval(OPEN_ORDERS_LUA, 1, key, 'remove', String(orderId), String(ttlSeconds));

/**
 * Patch a partially-filled order in place: executedQty, cumulative quote, and
 * status. No-op if the key is absent or the order is not in the list, so a
 * partial-fill event never fabricates an entry.
 */
export const patchOpenOrder = (
  redis: Redis,
  key: string,
  orderId: number,
  patch: { executedQty: string; cumQuote: string; status: string },
  ttlSeconds: number = OPEN_ORDERS_TTL_S,
): Promise<unknown> =>
  redis.eval(
    OPEN_ORDERS_LUA,
    1,
    key,
    'patch',
    String(orderId),
    patch.executedQty,
    patch.cumQuote,
    patch.status,
    String(ttlSeconds),
  );
