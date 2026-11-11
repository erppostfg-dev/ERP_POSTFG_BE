import { CloudWatchClient, DescribeAlarmsCommand, GetMetricDataCommand, type MetricDataQuery } from '@aws-sdk/client-cloudwatch';
import {
  CloudWatchLogsClient, DescribeLogGroupsCommand, FilterLogEventsCommand, GetQueryResultsCommand, StartQueryCommand, StopQueryCommand,
} from '@aws-sdk/client-cloudwatch-logs';
import { fromInstanceMetadata } from '@smithy/credential-provider-imds';
import { env } from '../../config/env';
import { MONITOR, MONITOR_ACCESS } from '../../constants';

/*
 * CloudWatch for Admin > Monitor (2026-11-05). Only the EC2's OWN role is used (fromInstanceMetadata): never the AWS
 * keys of .env (user: "only in the dev EC2, not the local one"). On a laptop the instance metadata is not there, so
 * onServer() is null and the page says so. Everything here only READS.
 */

let logs: CloudWatchLogsClient | undefined;
let metrics: CloudWatchClient | undefined;
const credentials = () => fromInstanceMetadata({ timeout: MONITOR.IMDS_TIMEOUT_MS, maxRetries: 1 });
const logsClient = () => (logs ??= new CloudWatchLogsClient({ region: env.monitor.region, credentials: credentials() }));
const metricsClient = () => (metrics ??= new CloudWatchClient({ region: env.monitor.region, credentials: credentials() }));

let instance: Promise<string | null> | undefined;
/** This server's EC2 instance id (IMDSv2), else null = not on EC2 (a laptop). Asked once. */
export const onServer = (): Promise<string | null> => (instance ??= (async () => {
  if (env.monitor.instanceId) return env.monitor.instanceId;
  try {
    const signal = AbortSignal.timeout(MONITOR.IMDS_TIMEOUT_MS);
    const token = await (await fetch('http://169.254.169.254/latest/api/token', { method: 'PUT', headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '60' }, signal })).text();
    const res = await fetch('http://169.254.169.254/latest/meta-data/instance-id', { headers: { 'X-aws-ec2-metadata-token': token }, signal });
    return res.ok ? (await res.text()).trim() || null : null;
  } catch {
    return null;
  }
})());

/** One Logs Insights query over [from, to] on our log group; the rows as field -> value (no "@ptr"). */
export const insights = async (query: string, from: Date, to: Date, limit?: number): Promise<Record<string, string>[]> => {
  const started = await logsClient().send(new StartQueryCommand({
    logGroupName: env.monitor.logGroup, queryString: query, startTime: Math.floor(from.getTime() / 1000), endTime: Math.ceil(to.getTime() / 1000), limit,
  }));
  const id = started.queryId;
  if (!id) throw new Error('CloudWatch gave no query id');
  const until = Date.now() + MONITOR.QUERY_TIMEOUT_MS;
  for (;;) {
    const res = await logsClient().send(new GetQueryResultsCommand({ queryId: id }));
    if (res.status === 'Complete') {
      return (res.results ?? []).map((row) => Object.fromEntries(row.filter((f) => f.field && f.field !== '@ptr').map((f) => [f.field!, f.value ?? ''])));
    }
    if (res.status === 'Failed' || res.status === 'Cancelled' || res.status === 'Timeout') throw new Error(`CloudWatch query ${String(res.status).toLowerCase()}`);
    if (Date.now() > until) {
      await logsClient().send(new StopQueryCommand({ queryId: id })).catch(() => undefined);
      throw new Error(`CloudWatch query took over ${MONITOR.QUERY_TIMEOUT_MS / 1000} s`);
    }
    await new Promise((r) => setTimeout(r, MONITOR.POLL_MS));
  }
};

export interface Series { id: string; label: string; points: { t: string; v: number }[] }

/** One GetMetricData call for these queries over [from, to]. */
export const metricData = async (queries: MetricDataQuery[], from: Date, to: Date): Promise<Series[]> => {
  const res = await metricsClient().send(new GetMetricDataCommand({ MetricDataQueries: queries, StartTime: from, EndTime: to, ScanBy: 'TimestampAscending' }));
  return (res.MetricDataResults ?? []).map((r) => ({
    id: r.Id ?? '', label: r.Label ?? '',
    points: (r.Timestamps ?? []).map((t, i) => ({ t: t.toISOString(), v: Number(r.Values?.[i] ?? 0) })),
  }));
};

/** Alarms in the account that name this server or the database (none set up on 5 Nov). */
export const alarms = async (): Promise<{ name: string; state: string; reason: string; updatedAt: string | null }[]> => {
  const res = await metricsClient().send(new DescribeAlarmsCommand({ MaxRecords: 100 }));
  return (res.MetricAlarms ?? []).map((a) => ({
    name: a.AlarmName ?? '', state: a.StateValue ?? '', reason: a.StateReason ?? '', updatedAt: a.StateUpdatedTimestamp?.toISOString() ?? null,
  }));
};

export interface AccessCheck { action: string; ok: boolean; error: string | null }

/** Tries each read the Monitor needs once, with this server's role: what is allowed (the page's "AWS access" panel). */
export const checkAccess = async (): Promise<AccessCheck[]> => {
  const now = new Date();
  const hourAgo = new Date(now.getTime() - 3_600_000);
  const tryIt = async (action: string, fn: () => Promise<unknown>): Promise<AccessCheck> => {
    try {
      await fn();
      return { action, ok: true, error: null };
    } catch (err) {
      const e = err as { name?: string; message?: string };
      return { action, ok: false, error: `${e.name ?? 'Error'}: ${(e.message ?? '').slice(0, 200)}` };
    }
  };
  return Promise.all([
    tryIt(MONITOR_ACCESS.DESCRIBE_LOG_GROUPS, () => logsClient().send(new DescribeLogGroupsCommand({ logGroupNamePrefix: env.monitor.logGroup, limit: 1 }))),
    tryIt(MONITOR_ACCESS.START_QUERY, () => insights('fields @timestamp | limit 1', hourAgo, now, 1)),
    tryIt(MONITOR_ACCESS.FILTER_LOG_EVENTS, () => logsClient().send(new FilterLogEventsCommand({ logGroupName: env.monitor.logGroup, limit: 1, startTime: hourAgo.getTime() }))),
    tryIt(MONITOR_ACCESS.GET_METRIC_DATA, () => metricData([{ Id: 'cpu', Expression: 'SEARCH(\'{AWS/EC2,InstanceId} MetricName="CPUUtilization"\', \'Average\', 300)', ReturnData: true }], hourAgo, now)),
    tryIt(MONITOR_ACCESS.DESCRIBE_ALARMS, () => alarms()),
  ]);
};
