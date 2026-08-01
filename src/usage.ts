// ABOUTME: Fetches and renders Kiro account usage from the management control plane.
// ABOUTME: Backs /kiro-usage — omp's own usage registry is closed to extensions.

import { getUsageLimits, type KiroManagementAuth, resolveKiroProfileArn } from "./management.js";

const MANAGE_URL = "https://app.kiro.dev/account/usage";
const BAR_WIDTH = 28;
const DAY_MS = 24 * 60 * 60 * 1000;

interface KiroUsageBreakdown {
  resourceType?: string;
  displayName?: string;
  displayNamePlural?: string;
  currentUsage: number;
  currentUsageWithPrecision?: number;
  currentOverages: number;
  currentOveragesWithPrecision?: number;
  usageLimit: number;
  usageLimitWithPrecision?: number;
  overageCharges: number;
  currency?: string;
}

export interface KiroUsageLimits {
  /** Epoch seconds. */
  nextDateReset?: number | null;
  subscriptionInfo?: { subscriptionTitle?: string };
  usageBreakdown?: KiroUsageBreakdown;
  usageBreakdownList?: KiroUsageBreakdown[];
}

/** Get-Usage-Limits rejects a missing profile with 400 "Invalid profileArn", so always send one. */
export async function fetchKiroUsage(auth: KiroManagementAuth, profileArn?: string): Promise<KiroUsageLimits> {
  return getUsageLimits<KiroUsageLimits>(auth, await resolveKiroProfileArn(auth, profileArn));
}

function formatCount(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2);
}

function bar(fraction: number): string {
  const filled = Math.max(0, Math.min(BAR_WIDTH, Math.round(fraction * BAR_WIDTH)));
  return `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`;
}

function formatBucket(bucket: KiroUsageBreakdown, label: string, labelWidth: number): string {
  const used = bucket.currentUsageWithPrecision ?? bucket.currentUsage;
  const limit = bucket.usageLimitWithPrecision ?? bucket.usageLimit;
  const fraction = limit > 0 ? used / limit : 0;
  const line = `  ${label.padEnd(labelWidth)}  ${bar(fraction)}  ${(fraction * 100).toFixed(1)}% used · ${formatCount(used)} / ${formatCount(limit)}`;

  const overages = bucket.currentOveragesWithPrecision ?? bucket.currentOverages;
  if (overages <= 0) return line;
  const charges = bucket.overageCharges > 0 ? ` (${bucket.overageCharges.toFixed(2)} ${bucket.currency || "USD"})` : "";
  return `${line}\n  ${" ".repeat(labelWidth)}  overage ${formatCount(overages)}${charges}`;
}

export function formatKiroUsage(usage: KiroUsageLimits, now = Date.now()): string {
  const buckets = usage.usageBreakdownList?.length
    ? usage.usageBreakdownList
    : usage.usageBreakdown
      ? [usage.usageBreakdown]
      : [];
  const title = usage.subscriptionInfo?.subscriptionTitle;
  const header = title ? `Kiro — ${title}` : "Kiro";
  if (buckets.length === 0) return `${header}\n  no usage data returned`;

  const rows = buckets.map((bucket) => ({
    bucket,
    label: bucket.displayNamePlural || bucket.displayName || bucket.resourceType || "Usage",
  }));
  const labelWidth = Math.max(...rows.map((row) => row.label.length));
  const days = usage.nextDateReset ? Math.max(0, Math.ceil((usage.nextDateReset * 1000 - now) / DAY_MS)) : undefined;
  const reset = days === undefined ? "" : `resets in ${days}d · `;
  const rendered = rows.map((row) => formatBucket(row.bucket, row.label, labelWidth));
  return [header, ...rendered, `  ${reset}${MANAGE_URL}`].join("\n");
}
