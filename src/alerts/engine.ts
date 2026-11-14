import type {
  Alert,
  AlertRuleConfig,
  AlertRuleId,
  MetricsSample,
  Timestamp,
} from '../types.js';

/**
 * Threshold evaluation.
 *
 * Every rule is of one shape: a measured value is bad when it is above a
 * threshold. That uniformity is what lets the anti-flapping logic be
 * written once and be right everywhere.
 *
 * Three mechanisms keep an alert from firing on noise.
 *
 * - A duration. The condition has to hold continuously for `forSeconds`
 *   before anything is raised, so a single spike between two samples is
 *   not an incident.
 * - Hysteresis. Once raised, the alert does not clear until the value
 *   falls back to `clearThreshold`, which is below the firing threshold.
 *   A value sitting exactly on the boundary therefore produces one alert
 *   rather than one per sample.
 * - A cooldown. After an alert resolves, the same rule and scope stay
 *   quiet for `cooldownSeconds`, so a condition that oscillates slowly
 *   does not produce a stream of alerts.
 *
 * The engine decides; it does not notify. Nothing is sent anywhere. An
 * alert is written to the local database and shown on the dashboard, and
 * that is the whole of its effect.
 */

export interface AlertSink {
  insertAlert(alert: Omit<Alert, 'id'>): number;
  resolveAlert(id: number, at: Timestamp): void;
}

export interface EvaluationContext {
  readonly now: Timestamp;
  readonly logicalCpus: number;
  /** Milliseconds since the last successful sample, or `null` if none. */
  readonly lastSampleAgeMs: number | null;
}

/** One measured value a rule can be applied to. */
export interface Observation {
  readonly rule: AlertRuleId;
  readonly scope: string | null;
  readonly value: number;
  /** Builds the message once the alert is actually raised. */
  readonly describe: (value: number, threshold: number) => string;
}

interface RuleState {
  /** When the value first went over the threshold, or `null`. */
  breachedAt: Timestamp | null;
  activeId: number | null;
  activeSince: Timestamp | null;
  lastResolvedAt: Timestamp | null;
}

export interface AlertChange {
  readonly kind: 'raised' | 'resolved';
  readonly alert: Alert;
}

function percent(value: number): string {
  return `${value.toFixed(1)}%`;
}

/**
 * Turns a sample into the values the rules are applied to.
 *
 * A metric that could not be measured produces no observation at all, so
 * a missing reading never triggers an alert and never clears one. The
 * agent-stale rule is the exception that covers that case: if readings
 * stop arriving, it is the thing that says so.
 */
export function observationsFor(
  sample: MetricsSample,
  context: EvaluationContext,
): Observation[] {
  const observations: Observation[] = [];

  if (sample.cpu.usage !== null) {
    observations.push({
      rule: 'cpu-high',
      scope: null,
      value: sample.cpu.usage,
      describe: (value, threshold) =>
        `CPU utilisation ${percent(value)} is above the ${percent(threshold)} threshold`,
    });
  }

  observations.push({
    rule: 'memory-high',
    scope: null,
    value: sample.memory.usage,
    describe: (value, threshold) =>
      `Memory utilisation ${percent(value)} is above the ${percent(threshold)} threshold`,
  });

  for (const filesystem of sample.disk.filesystems) {
    // A read-only filesystem is full by design — a mounted image, a
    // recovery partition — and alerting on it is noise.
    if (filesystem.readOnly) continue;
    observations.push({
      rule: 'disk-low',
      scope: filesystem.mountPoint,
      value: filesystem.usage,
      describe: (value, threshold) =>
        `Filesystem ${filesystem.mountPoint} is ${percent(value)} full, ` +
        `above the ${percent(threshold)} threshold`,
    });
  }

  if (context.logicalCpus > 0) {
    const ratio = sample.cpu.loadAverage.one / context.logicalCpus;
    observations.push({
      rule: 'load-high',
      scope: null,
      value: ratio,
      describe: (value, threshold) =>
        `Load average ${sample.cpu.loadAverage.one.toFixed(2)} is ` +
        `${value.toFixed(2)} per logical CPU, above the ` +
        `${threshold.toFixed(2)} threshold`,
    });
  }

  return observations;
}

export class AlertEngine {
  private readonly rules = new Map<AlertRuleId, AlertRuleConfig>();
  private readonly states = new Map<string, RuleState>();
  private readonly sink: AlertSink;

  constructor(rules: readonly AlertRuleConfig[], sink: AlertSink) {
    for (const rule of rules) this.rules.set(rule.id, rule);
    this.sink = sink;
  }

  /** Restores engine state for alerts left active by a previous run. */
  adopt(active: readonly Alert[]): void {
    for (const alert of active) {
      this.states.set(keyOf(alert.rule, alert.scope), {
        breachedAt: alert.startedAt,
        activeId: alert.id,
        activeSince: alert.startedAt,
        lastResolvedAt: null,
      });
    }
  }

  /**
   * Applies every rule to one sample and returns what changed.
   *
   * The staleness rule is evaluated from the context rather than from the
   * sample, because the situation it describes is one where there is no
   * recent sample to evaluate.
   */
  evaluate(
    sample: MetricsSample | null,
    context: EvaluationContext,
  ): AlertChange[] {
    const changes: AlertChange[] = [];
    const seen = new Set<string>();

    const observations =
      sample === null ? [] : observationsFor(sample, context);

    if (context.lastSampleAgeMs !== null) {
      observations.push({
        rule: 'agent-stale',
        scope: null,
        value: context.lastSampleAgeMs / 1000,
        describe: (value, threshold) =>
          `No metrics for ${value.toFixed(0)} seconds, above the ` +
          `${threshold.toFixed(0)} second threshold`,
      });
    }

    for (const observation of observations) {
      const rule = this.rules.get(observation.rule);
      if (rule?.enabled !== true) continue;
      const key = keyOf(observation.rule, observation.scope);
      seen.add(key);
      const change = this.apply(rule, observation, key, context.now);
      if (change !== null) changes.push(change);
    }

    // A scope that has gone — an unmounted filesystem — cannot be
    // measured again, so anything active for it is resolved rather than
    // left hanging for ever.
    for (const [key, state] of this.states) {
      if (seen.has(key) || state.activeId === null) continue;
      const resolved = this.resolve(key, state, context.now);
      if (resolved !== null) changes.push(resolved);
    }

    return changes;
  }

  private apply(
    rule: AlertRuleConfig,
    observation: Observation,
    key: string,
    now: Timestamp,
  ): AlertChange | null {
    const state = this.states.get(key) ?? {
      breachedAt: null,
      activeId: null,
      activeSince: null,
      lastResolvedAt: null,
    };
    this.states.set(key, state);

    if (state.activeId !== null) {
      if (observation.value <= rule.clearThreshold) {
        return this.resolve(key, state, now);
      }
      return null;
    }

    if (observation.value <= rule.threshold) {
      state.breachedAt = null;
      return null;
    }

    state.breachedAt ??= now;
    if (now - state.breachedAt < rule.forSeconds * 1000) return null;

    if (
      state.lastResolvedAt !== null &&
      now - state.lastResolvedAt < rule.cooldownSeconds * 1000
    ) {
      return null;
    }

    const pending: Omit<Alert, 'id'> = {
      rule: rule.id,
      severity: rule.severity,
      state: 'active',
      scope: observation.scope,
      message: observation.describe(observation.value, rule.threshold),
      value: round2(observation.value),
      threshold: rule.threshold,
      startedAt: now,
      resolvedAt: null,
    };

    const id = this.sink.insertAlert(pending);
    state.activeId = id;
    state.activeSince = now;

    return { kind: 'raised', alert: { id, ...pending } };
  }

  private resolve(
    key: string,
    state: RuleState,
    now: Timestamp,
  ): AlertChange | null {
    const id = state.activeId;
    if (id === null) return null;
    this.sink.resolveAlert(id, now);
    const startedAt = state.activeSince ?? now;
    state.activeId = null;
    state.activeSince = null;
    state.breachedAt = null;
    state.lastResolvedAt = now;

    const [rule, scope] = splitKey(key);
    const configured = this.rules.get(rule);

    return {
      kind: 'resolved',
      alert: {
        id,
        rule,
        severity: configured?.severity ?? 'warning',
        state: 'resolved',
        scope,
        message: 'Condition cleared',
        value: 0,
        threshold: configured?.threshold ?? 0,
        startedAt,
        resolvedAt: now,
      },
    };
  }
}

function keyOf(rule: AlertRuleId, scope: string | null): string {
  return `${rule}\u0000${scope ?? ''}`;
}

function splitKey(key: string): [AlertRuleId, string | null] {
  const [rule, scope] = key.split('\u0000');
  return [
    (rule ?? 'cpu-high') as AlertRuleId,
    scope === undefined || scope.length === 0 ? null : scope,
  ];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
