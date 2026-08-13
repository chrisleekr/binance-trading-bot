const direct = process.env.DIRECT_UNDOCUMENTED;
const bracket = process.env['BRACKET_UNDOCUMENTED'];
const raw: NodeJS.ProcessEnv = process.env;
const alias = raw.ALIAS_UNDOCUMENTED;
const meta = import.meta.env as Record<string, string | undefined>;
const castMeta = meta.CAST_META_UNDOCUMENTED;
const beforeCast = (import.meta as { env: Record<string, string | undefined> }).env;
const castBeforeMeta = beforeCast.CAST_BEFORE_META_UNDOCUMENTED;
const { DESTRUCTURED_UNDOCUMENTED } = process.env;
const scopedEnv = process.env;
const shadow = (scopedEnv: Record<string, string>): string | undefined => scopedEnv.UNRELATED;
const afterShadow = scopedEnv.AFTER_SHADOW_UNDOCUMENTED;

export const values = {
  direct,
  bracket,
  alias,
  castMeta,
  castBeforeMeta,
  DESTRUCTURED_UNDOCUMENTED,
  shadow,
  afterShadow,
};
