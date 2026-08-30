import type { TestProjectInlineConfiguration } from 'vitest/config';

export interface CoverageThresholds {
  readonly lines: number;
  readonly branches: number;
}

export type CoveragePolicyEntry =
  | {
      readonly lane: string;
      readonly include: readonly string[];
      readonly thresholds: CoverageThresholds;
    }
  | { readonly exemption: string; readonly lane?: string };

export type ProjectOptions = TestProjectInlineConfiguration & { readonly packageName?: string };

export const SOURCE_COVERAGE_INCLUDE: readonly string[];
export const COVERAGE_POLICY: Readonly<Record<string, CoveragePolicyEntry>>;
export const PER_PACKAGE_THRESHOLDS: Readonly<Record<string, CoverageThresholds>>;

/**
 * Keeps coverage-lane selection tied to the shared policy table instead of consumer-local copies.
 * @param packageName - Workspace package name used as the policy key.
 * @returns The package policy, or null when no entry exists.
 */
export function coveragePolicyFor(packageName: string): CoveragePolicyEntry | null;

/**
 * Applies the repository's required Vitest defaults while accepting package-specific test options.
 * @param overrides - Project configuration merged over the shared defaults, with an optional coverage-policy package key.
 * @returns A Vitest project configuration with shared reporters and coverage policy applied.
 */
export function defineProject(overrides?: ProjectOptions): TestProjectInlineConfiguration;
