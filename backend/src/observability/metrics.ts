const STATUS_CLASSES = ['1xx', '2xx', '3xx', '4xx', '5xx'] as const;
const HTTP_METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'OTHER'] as const;

type MetricKind = 'counter' | 'gauge' | 'histogram';
type Labels = Record<string, string>;

interface MetricDefinition {
  name: string;
  help: string;
  kind: MetricKind;
  labelNames: readonly string[];
  allowedLabels: Record<string, ReadonlySet<string> | 'matched_route'>;
  buckets?: readonly number[];
}

interface HistogramValue {
  count: number;
  sum: number;
  buckets: number[];
}

type MetricValue = number | HistogramValue;

const ROUTE_MAX_LENGTH = 160;
const ROUTE_MAX_SEGMENTS = 12;
const ROUTE_TEMPLATE = /^\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*|\*splat)(?:\/(?:[A-Za-z0-9._~-]+|:[A-Za-z][A-Za-z0-9_]*|\*splat))*$/;

export function boundedMatchedRoute(route: string | undefined): string {
  if (!route || route === 'UNMATCHED') return 'UNMATCHED';
  if (route.length > ROUTE_MAX_LENGTH) return 'UNMATCHED';
  if (route.split('/').length - 1 > ROUTE_MAX_SEGMENTS) return 'UNMATCHED';
  return ROUTE_TEMPLATE.test(route) ? route : 'UNMATCHED';
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
}

function labelKey(names: readonly string[], labels: Labels): string {
  return names.map((name) => `${name}=${labels[name]}`).join('\u0000');
}

function labelText(names: readonly string[], labels: Labels): string {
  if (!names.length) return '';
  return `{${names.map((name) => `${name}="${escapeLabel(labels[name])}"`).join(',')}}`;
}

export class BoundedMetricsRegistry {
  private readonly definitions = new Map<string, MetricDefinition>();
  private readonly values = new Map<string, Map<string, { labels: Labels; value: MetricValue }>>();

  constructor(private readonly maxSeries = 4_096) {}

  define(definition: MetricDefinition): void {
    if (this.definitions.has(definition.name)) return;
    this.definitions.set(definition.name, definition);
    this.values.set(definition.name, new Map());
  }

  private normalize(definition: MetricDefinition, labels: Labels): Labels | undefined {
    const output: Labels = {};
    for (const name of definition.labelNames) {
      const raw = labels[name];
      if (typeof raw !== 'string') return undefined;
      const policy = definition.allowedLabels[name];
      const value = policy === 'matched_route' ? boundedMatchedRoute(raw) : raw;
      if (policy !== 'matched_route' && !policy?.has(value)) return undefined;
      output[name] = value;
    }
    return output;
  }

  private series(definition: MetricDefinition, labels: Labels): { labels: Labels; value: MetricValue } | undefined {
    const normalized = this.normalize(definition, labels);
    if (!normalized) return undefined;
    const map = this.values.get(definition.name)!;
    const key = labelKey(definition.labelNames, normalized);
    const existing = map.get(key);
    if (existing) return existing;
    if (this.seriesCount() >= this.maxSeries) return undefined;
    const value: MetricValue = definition.kind === 'histogram'
      ? { count: 0, sum: 0, buckets: (definition.buckets ?? []).map(() => 0) }
      : 0;
    const created = { labels: normalized, value };
    map.set(key, created);
    return created;
  }

  increment(name: string, labels: Labels, amount = 1): void {
    try {
      const definition = this.definitions.get(name);
      if (!definition || definition.kind !== 'counter' || !Number.isFinite(amount) || amount < 0) return;
      const series = this.series(definition, labels);
      if (series && typeof series.value === 'number') series.value += amount;
    } catch { /* metrics fail soft */ }
  }

  set(name: string, labels: Labels, value: number): void {
    try {
      const definition = this.definitions.get(name);
      if (!definition || definition.kind !== 'gauge' || !Number.isFinite(value)) return;
      const series = this.series(definition, labels);
      if (series) series.value = value;
    } catch { /* metrics fail soft */ }
  }

  observe(name: string, labels: Labels, value: number): void {
    try {
      const definition = this.definitions.get(name);
      if (!definition || definition.kind !== 'histogram' || !Number.isFinite(value) || value < 0) return;
      const series = this.series(definition, labels);
      if (!series || typeof series.value === 'number') return;
      const histogram = series.value;
      histogram.count += 1;
      histogram.sum += value;
      (definition.buckets ?? []).forEach((upper, index) => {
        if (value <= upper) histogram.buckets[index] += 1;
      });
    } catch { /* metrics fail soft */ }
  }

  seriesCount(): number {
    let count = 0;
    for (const map of this.values.values()) count += map.size;
    return count;
  }

  render(): string {
    const lines: string[] = [];
    for (const definition of this.definitions.values()) {
      lines.push(`# HELP ${definition.name} ${definition.help}`);
      lines.push(`# TYPE ${definition.name} ${definition.kind}`);
      for (const series of this.values.get(definition.name)?.values() ?? []) {
        const labels = labelText(definition.labelNames, series.labels);
        if (typeof series.value === 'number') {
          lines.push(`${definition.name}${labels} ${series.value}`);
          continue;
        }
        const histogram = series.value;
        const buckets = definition.buckets ?? [];
        buckets.forEach((upper, index) => {
          const bucketLabels = { ...series.labels, le: String(upper) };
          lines.push(`${definition.name}_bucket${labelText([...definition.labelNames, 'le'], bucketLabels)} ${histogram.buckets[index]}`);
        });
        const infLabels = { ...series.labels, le: '+Inf' };
        lines.push(`${definition.name}_bucket${labelText([...definition.labelNames, 'le'], infLabels)} ${histogram.count}`);
        lines.push(`${definition.name}_sum${labels} ${histogram.sum}`);
        lines.push(`${definition.name}_count${labels} ${histogram.count}`);
      }
    }
    return `${lines.join('\n')}\n`;
  }

  reset(): void {
    for (const map of this.values.values()) map.clear();
  }
}

const set = (values: readonly string[]) => new Set(values);

export const metrics = new BoundedMetricsRegistry();

metrics.define({
  name: 'http_requests_total', help: 'Completed HTTP requests.', kind: 'counter',
  labelNames: ['method', 'matched_route', 'status_class'],
  allowedLabels: { method: set(HTTP_METHODS), matched_route: 'matched_route', status_class: set(STATUS_CLASSES) },
});
metrics.define({
  name: 'http_request_duration_seconds', help: 'HTTP request duration from a monotonic clock.', kind: 'histogram',
  labelNames: ['method', 'matched_route'],
  allowedLabels: { method: set(HTTP_METHODS), matched_route: 'matched_route' },
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30],
});
metrics.define({
  name: 'http_response_bytes_total', help: 'Actual bytes written in completed HTTP responses.', kind: 'counter',
  labelNames: ['matched_route', 'status_class'],
  allowedLabels: { matched_route: 'matched_route', status_class: set(STATUS_CLASSES) },
});
metrics.define({
  name: 'media_resolve_total', help: 'Media provider resolution attempts.', kind: 'counter',
  labelNames: ['provider_type', 'result'],
  allowedLabels: {
    provider_type: set(['direct-url', 'generic-web', 'browser', 'bilibili', 'local-file', 'webdav', 'ftp', 'openlist', 'emby', 'jellyfin', 'anisubs', 'kazumi', 'anime', 'live', 'ncm', 'unknown']),
    result: set(['success', 'timeout', 'auth_error', 'unavailable', 'invalid', 'internal']),
  },
});
metrics.define({
  name: 'media_gateway_requests_total', help: 'Authorized media gateway requests.', kind: 'counter',
  labelNames: ['resource_kind', 'transport_mode', 'result'],
  allowedLabels: {
    resource_kind: set(['media', 'manifest', 'segment', 'part', 'key', 'init', 'auxiliary', 'music', 'unknown']),
    transport_mode: set(['direct', 'manifest', 'partial_proxy', 'full_proxy', 'local', 'unknown']),
    result: set(['success', 'denied', 'not_found', 'upstream_error', 'aborted', 'internal']),
  },
});
metrics.define({
  name: 'slice_cache_total', help: 'Slice cache outcomes.', kind: 'counter',
  labelNames: ['outcome'], allowedLabels: { outcome: set(['hit', 'miss', 'bypass', 'error']) },
});
for (const name of ['active_room_count', 'active_socket_count', 'active_voice_member_count', 'music_room_count']) {
  metrics.define({ name, help: `Current ${name.replace(/_/g, ' ')}.`, kind: 'gauge', labelNames: [], allowedLabels: {} });
}
metrics.define({
  name: 'realtime_rejected_total', help: 'Rejected realtime mutations.', kind: 'counter',
  labelNames: ['reason'], allowedLabels: { reason: set(['unauthorized', 'stale', 'invalid', 'rate_limited', 'not_member', 'internal']) },
});
metrics.define({
  name: 'voice_packet_dropped_total', help: 'Dropped voice packets.', kind: 'counter',
  labelNames: ['reason'], allowedLabels: { reason: set(['muted', 'not_member', 'invalid', 'rate_limited', 'stale', 'internal']) },
});
for (const name of ['database_migration_total', 'update_check_total', 'update_apply_total']) {
  metrics.define({
    name, help: `${name.replace(/_/g, ' ')} outcomes.`, kind: 'counter',
    labelNames: ['result'], allowedLabels: { result: set(['success', 'noop', 'blocked', 'failed', 'rollback']) },
  });
}

export function httpMethod(method: string): string {
  const upper = method.toUpperCase();
  return (HTTP_METHODS as readonly string[]).includes(upper) ? upper : 'OTHER';
}

export function statusClass(status: number): string {
  const value = `${Math.floor(status / 100)}xx`;
  return (STATUS_CLASSES as readonly string[]).includes(value) ? value : '5xx';
}
