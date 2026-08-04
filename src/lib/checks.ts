/**
 * The reconciliation check registry, shared by reconcile.ts (which must
 * produce every row) and dashboard.ts (which refuses to render unless the
 * latest run contains the full set). A check silently not running is
 * indistinguishable from a check passing unless presence itself is asserted.
 */

export const REQUIRED_CHECKS = [
  "1_draws_minus_repays_eq_vat_art",
  "2_scaled_times_index_eq_balanceOf",
  "3_sum_revenue_eq_balance_growth",
  "4_segment_continuity_and_coverage",
  "5_buffer_balance_eq_net_flow",
  "6_stored_addresses_eq_fresh_resolution",
  "7_chi_rpow_recomputation",
  "8_DIAGNOSTIC_rate_integral_vs_index_revenue",
  "9_DIAGNOSTIC_utilization_definitions",
] as const;

export const isDiagnostic = (name: string): boolean => name.includes("DIAGNOSTIC");
