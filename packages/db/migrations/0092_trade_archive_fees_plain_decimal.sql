-- Normalise stored `trade_archive.fees` values that were written in exponential notation.
--
-- The producer formatted each per-asset commission total with `Decimal#toString()`, which switches to exponential notation outside decimal.js's -7 / 21 exponent thresholds. A BNB commission on a discounted account clears the small side routinely, so rows carry text like `1e-8` where every reader expects `0.00000001`. The values are jsonb STRINGS, so Postgres normalised nothing on the way in, and the api serves them verbatim into a table cell beside a column of fixed decimals.
--
-- The producer is fixed forward; this repairs what is already stored. Scoped by an exponent-shaped regex for two reasons: an already-plain value must come back byte-identical, because an unconditional `::numeric` round-trip would re-scale every stored fee and turn a targeted repair into a whole-table rewrite; and the same predicate is what guarantees no non-numeric string can ever reach the cast.
--
-- The exponent is bounded to four digits, and both copies of the predicate carry the identical pattern. Unbounded, a stored `1e-20000` would match and then abort the `::numeric` cast — Postgres numeric allows at most 16383 digits after the point — which rolls the whole migration back, writes no `_app_migrations` row, and re-aborts on every subsequent deploy. A shipped migration is immutable, so the only exit from that state is authoring another one. decimal.js only goes exponential outside exponents of -7 and 21, so four digits is far more than any value this producer can emit.
--
-- Only `fees` is touched. `fees_quote` is `numeric(38,18)` and Postgres normalised it on write, so it never held an exponent. `fees_quote_complete` is a claim about fee EVIDENCE, and re-spelling a string is not new evidence — a row that could not be valued before this migration still cannot be, and flipping the marker would claim exact Net P/L for it.
--
-- `trade_archive` is an ordinary table, not a hypertable, so there is no chunk or root-heap handling to do here.

with candidate as (
  -- Filtered in its own scan so `jsonb_each` below can never be handed a non-object. Ordering between a type guard and an EXISTS in one WHERE clause is the planner's to choose; a separate CTE removes the question.
  select id, fees
  from trade_archive
  where jsonb_typeof(fees) = 'object'
),
rewritten as (
  select
    c.id,
    jsonb_object_agg(
      kv.key,
      case
        when jsonb_typeof(kv.value) = 'string'
          and (kv.value #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?[eE][+-]?[0-9]{1,4}$'
        then to_jsonb(((kv.value #>> '{}')::numeric)::text)
        else kv.value
      end
    ) as fees
  from candidate c, jsonb_each(c.fees) kv
  group by c.id
  -- Only rows that actually carry an exponent are rewritten; a row whose every value is already plain is not in this result and is never written to.
  having bool_or(
    jsonb_typeof(kv.value) = 'string'
    and (kv.value #>> '{}') ~ '^-?[0-9]+(\.[0-9]+)?[eE][+-]?[0-9]{1,4}$'
  )
)
update trade_archive t
set fees = r.fees
from rewritten r
where t.id = r.id;
