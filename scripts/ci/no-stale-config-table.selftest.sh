#!/usr/bin/env bash
# Exercises the docs generator's pure shipped-default validator. Importing the
# generator is safe because its main entry is guarded by import.meta.main.
set -uo pipefail

dir="$(cd -- "$(dirname -- "$0")" && pwd)"
generator="$dir/../docs/gen-config-tables.ts"

out="$(GENERATOR="$generator" bun -e '
const mod = await import(process.env.GENERATOR);
const validate = mod.shippedDefaultGaps;
if (typeof validate !== "function") {
  console.error("missing exported shippedDefaultGaps validator");
  process.exit(1);
}

const entry = (shippedDefault) => ({ shippedDefault });
const catalogue = {
  SHIPPED_DEFAULT: entry("expected"),
  ORDINARY_NOTE: entry(undefined),
};

const mismatch = validate("SHIPPED_DEFAULT=wrong\n", catalogue);
if (!mismatch.some((line) => line.includes("SHIPPED_DEFAULT") && line.includes("expected") && line.includes("wrong"))) {
  console.error("mismatch probe did not report key, expected value and shipped value");
  process.exit(1);
}

const valid = validate("SHIPPED_DEFAULT=expected\n", catalogue);
if (valid.length !== 0) {
  console.error("matching shipped default was rejected: " + valid.join("; "));
  process.exit(1);
}

const absent = validate("", catalogue);
if (!absent.some((line) => line.includes("SHIPPED_DEFAULT") && line.includes("absent from .env.example"))) {
  console.error("absent-key probe did not report the missing shipped default");
  process.exit(1);
}

const vacuous = validate("ORDINARY_NOTE=ignored\n", {
  ORDINARY_NOTE: catalogue.ORDINARY_NOTE,
});
if (!vacuous.some((line) => line.includes("zero shipped-default claims"))) {
  console.error("zero-claim probe passed vacuously");
  process.exit(1);
}
' 2>&1)"
rc=$?

if [ "$rc" -ne 0 ]; then
  echo "FAIL: $out"
  echo 'no-stale-config-table self-test: RED'
  exit 1
fi

echo 'no-stale-config-table self-test: OK'
