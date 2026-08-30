import type { Queue } from "bullmq";
import type { AutoscaleConfig } from "#/config.ts";
import { readBacklog } from "#/backlog.ts";
import { log } from "#/log.ts";

/**
 * Autoscaling the worker fleet.
 *
 * Railway has no built-in autoscaler. It scales each container *vertically* on
 * its own — CPU and memory grow toward the plan limits under load — but the
 * replica count is a setting you own, and it stays where you put it until
 * something changes it. Railway's answer, and its documented guidance for
 * worker services, is to run a small process that measures load and moves
 * `numReplicas` through the Public API. That is this file.
 *
 * It runs inside the `pipeline` server rather than as a third service because
 * everything it needs is already here: the queue handles it measures, a Redis
 * connection, and a process that is up whenever the project is. A separate
 * autoscaler service would need all three duplicated to do strictly less.
 *
 * The whole feature is opt-in — no `RAILWAY_API_TOKEN`, no loop — so local dev
 * and any environment that would rather set replicas by hand simply never start
 * it. See `.railway/railway.ts` for how the token and bounds are provisioned.
 */

const API = "https://backboard.railway.com/graphql/v2";

// --- the decision ---------------------------------------------------------

export interface ScaleDecision {
  desired: number;
  /** Why `desired` is what it is — logged, and surfaced by `GET /autoscale`. */
  reason: string;
  changed: boolean;
}

export interface DecisionInput {
  pending: number;
  current: number;
  now: number;
  /** `undefined` until this process has scaled down once. */
  lastScaleDownAt: number | undefined;
}

/**
 * Pure, so the policy can be tested without a Redis or a Railway account.
 *
 * Up is immediate and down waits out a cooldown. That asymmetry is the point:
 * being one replica short costs latency on a visible backlog, while being one
 * replica long costs a few minutes of a container that was already running. A
 * symmetric policy flaps — a queue that empties between two ticks would scale
 * down, then straight back up on the next burst, and every cycle interrupts
 * whatever the drained replica was doing.
 */
export function decideReplicas(config: AutoscaleConfig, input: DecisionInput): ScaleDecision {
  const { pending, current, now, lastScaleDownAt } = input;

  const needed = Math.ceil(pending / config.backlogPerReplica);
  const desired = Math.min(config.maxReplicas, Math.max(config.minReplicas, needed));

  if (desired === current) {
    return { desired, reason: `holding at ${current} for ${pending} pending`, changed: false };
  }

  if (desired > current) {
    return { desired, reason: `${pending} pending needs ${desired} replicas, have ${current}`, changed: true };
  }

  const sinceLastScaleDown = lastScaleDownAt === undefined ? Infinity : now - lastScaleDownAt;
  if (sinceLastScaleDown < config.scaleDownCooldownMs) {
    const waitMs = config.scaleDownCooldownMs - sinceLastScaleDown;
    return { desired: current, reason: `scale-down to ${desired} held for another ${Math.ceil(waitMs / 1000)}s of cooldown`, changed: false };
  }

  return { desired, reason: `${pending} pending needs only ${desired} replicas, have ${current}`, changed: true };
}

// --- the Railway Public API ----------------------------------------------

/**
 * Project tokens authenticate with `Project-Access-Token`; account and workspace
 * tokens use `Authorization: Bearer`. Rather than make the operator declare
 * which kind they pasted in, try the project header first (the one Railway
 * recommends for automation) and fall back once, remembering what worked.
 */
type TokenStyle = "project" | "bearer";

function headersFor(style: TokenStyle, token: string): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(style === "project" ? { "Project-Access-Token": token } : { authorization: `Bearer ${token}` }),
  };
}

class RailwayApi {
  #token: string;
  #style: TokenStyle = "project";

  constructor(token: string) {
    this.#token = token;
  }

  async #post(style: TokenStyle, query: string, variables: Record<string, unknown>): Promise<{ data?: unknown; errors?: unknown }> {
    const res = await fetch(API, {
      method: "POST",
      headers: headersFor(style, this.#token),
      body: JSON.stringify({ query, variables }),
    });
    if (!res.ok && res.status !== 400) {
      throw new Error(`Railway API returned ${res.status}`);
    }
    return (await res.json()) as { data?: unknown; errors?: unknown };
  }

  async gql<T>(query: string, variables: Record<string, unknown>): Promise<T> {
    let body = await this.#post(this.#style, query, variables);
    // An auth failure comes back as a GraphQL error, not an HTTP status, so the
    // fallback has to inspect the payload.
    if (body.errors && /not authorized|unauthorized/i.test(JSON.stringify(body.errors))) {
      const other: TokenStyle = this.#style === "project" ? "bearer" : "project";
      const retried = await this.#post(other, query, variables);
      if (!retried.errors) {
        log.info("autoscale: switched Railway token style", { style: other });
        this.#style = other;
      }
      body = retried;
    }
    if (body.errors) {
      throw new Error(`Railway API error: ${JSON.stringify(body.errors)}`);
    }
    return body.data as T;
  }
}

const SERVICE_INSTANCE_QUERY = `
  query ($serviceId: String!, $environmentId: String!) {
    serviceInstance(serviceId: $serviceId, environmentId: $environmentId) {
      numReplicas
    }
  }
`;

const SERVICE_INSTANCE_UPDATE = `
  mutation ($serviceId: String!, $environmentId: String!, $input: ServiceInstanceUpdateInput!) {
    serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
  }
`;

const PROJECT_SERVICES_QUERY = `
  query ($projectId: String!) {
    project(id: $projectId) {
      services { edges { node { id name } } }
    }
  }
`;

// --- the loop -------------------------------------------------------------

export interface AutoscalerState {
  enabled: boolean;
  targetServiceId: string | undefined;
  lastCheckedAt: string | undefined;
  lastPending: number | undefined;
  lastReplicas: number | undefined;
  lastDecision: string | undefined;
  lastError: string | undefined;
}

export class Autoscaler {
  #config: AutoscaleConfig;
  #queues: Iterable<Queue>;
  #api: RailwayApi;
  #timer: NodeJS.Timeout | undefined;
  #stopped = false;
  #serviceId: string | undefined;
  #lastScaleDownAt: number | undefined;
  #state: AutoscalerState;

  constructor(config: AutoscaleConfig, queues: Iterable<Queue>) {
    this.#config = config;
    this.#queues = queues;
    this.#api = new RailwayApi(config.apiToken);
    this.#serviceId = config.targetServiceId;
    this.#state = {
      enabled: true,
      targetServiceId: config.targetServiceId,
      lastCheckedAt: undefined,
      lastPending: undefined,
      lastReplicas: undefined,
      lastDecision: undefined,
      lastError: undefined,
    };
  }

  get state(): AutoscalerState {
    return { ...this.#state };
  }

  /**
   * Railway injects `RAILWAY_PROJECT_ID` and `RAILWAY_ENVIRONMENT_ID` into every
   * container but not a *sibling* service's id, and IaC has no id to hand over
   * either — service ids are created by the platform. So the target is named,
   * and resolved to an id once per process. `AUTOSCALE_TARGET_SERVICE_ID` skips
   * this when the id is known and the token cannot read the project.
   */
  async #resolveServiceId(): Promise<string> {
    if (this.#serviceId) return this.#serviceId;

    const projectId = this.#config.projectId;
    if (!projectId) {
      throw new Error("cannot resolve the target service: neither AUTOSCALE_TARGET_SERVICE_ID nor RAILWAY_PROJECT_ID is set");
    }

    const data = await this.#api.gql<{ project: { services: { edges: { node: { id: string; name: string } }[] } } }>(PROJECT_SERVICES_QUERY, { projectId });
    const match = data.project.services.edges.find((edge) => edge.node.name === this.#config.targetServiceName);
    if (!match) {
      throw new Error(`no service named "${this.#config.targetServiceName}" in project ${projectId}`);
    }

    this.#serviceId = match.node.id;
    this.#state.targetServiceId = match.node.id;
    log.info("autoscale: resolved target service", { service: this.#config.targetServiceName, serviceId: match.node.id });
    return match.node.id;
  }

  async #tick(): Promise<void> {
    const environmentId = this.#config.environmentId;
    if (!environmentId) {
      throw new Error("RAILWAY_ENVIRONMENT_ID is not set");
    }

    const serviceId = await this.#resolveServiceId();
    const snapshot = await readBacklog(this.#queues);

    const instance = await this.#api.gql<{ serviceInstance: { numReplicas: number | null } }>(SERVICE_INSTANCE_QUERY, { serviceId, environmentId });
    const current = instance.serviceInstance.numReplicas ?? 1;

    const now = Date.now();
    const decision = decideReplicas(this.#config, {
      pending: snapshot.pending,
      current,
      now,
      lastScaleDownAt: this.#lastScaleDownAt,
    });

    this.#state.lastCheckedAt = new Date(now).toISOString();
    this.#state.lastPending = snapshot.pending;
    this.#state.lastReplicas = current;
    this.#state.lastDecision = decision.reason;
    this.#state.lastError = undefined;

    if (!decision.changed) {
      log.info("autoscale: no change", { pending: snapshot.pending, replicas: current, reason: decision.reason });
      return;
    }

    if (this.#config.dryRun) {
      log.info("autoscale: dry run", { pending: snapshot.pending, from: current, to: decision.desired, reason: decision.reason });
      return;
    }

    await this.#api.gql(SERVICE_INSTANCE_UPDATE, { serviceId, environmentId, input: { numReplicas: decision.desired } });
    if (decision.desired < current) this.#lastScaleDownAt = now;
    this.#state.lastReplicas = decision.desired;

    log.info("autoscale: scaled", { pending: snapshot.pending, from: current, to: decision.desired, reason: decision.reason });
  }

  #schedule(): void {
    if (this.#stopped) return;
    // A fresh timer per tick rather than setInterval: a slow API call must delay
    // the next check, never stack a second one on top of it.
    this.#timer = setTimeout(() => {
      void this.#run();
    }, this.#config.intervalMs);
    // Never hold the process open on the autoscaler's account.
    this.#timer.unref();
  }

  async #run(): Promise<void> {
    try {
      await this.#tick();
    } catch (err) {
      // A failing autoscaler must not take the board down with it — the fleet
      // simply stays where it is until the next tick succeeds.
      this.#state.lastError = String(err);
      log.error("autoscale: tick failed", { err: String(err) });
    }
    this.#schedule();
  }

  start(): void {
    log.info("autoscale: started", {
      target: this.#config.targetServiceName,
      min: this.#config.minReplicas,
      max: this.#config.maxReplicas,
      backlogPerReplica: this.#config.backlogPerReplica,
      intervalSeconds: Math.round(this.#config.intervalMs / 1000),
      dryRun: this.#config.dryRun,
    });
    void this.#run();
  }

  stop(): void {
    this.#stopped = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}

export const DISABLED_STATE: AutoscalerState = {
  enabled: false,
  targetServiceId: undefined,
  lastCheckedAt: undefined,
  lastPending: undefined,
  lastReplicas: undefined,
  lastDecision: undefined,
  lastError: undefined,
};
