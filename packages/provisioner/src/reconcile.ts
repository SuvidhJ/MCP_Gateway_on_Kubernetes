// The provisioning state machine. Desired state and progress live in Postgres (`provisions`), so the provisioner
// can stop at any point (crash, rollout, node drain) and the next leader resumes: every step is idempotent (server-
// side apply, create-if-absent), and each run re-applies from the top until the resource is ready. A run that cannot
// finish fails cleanly with the reason (image can't be pulled, container keeps crashing, quota or Pod Security
// refused it, bootstrap failed, or the timeout passed while waiting for <step>).
import type pg from 'pg';
import { MANAGED_LABEL, MANAGED_VALUE, makeSealer } from '@urumi/shared';
import { kube, KubeError } from './kube.js';
import {
  guardrails, hostedServer, mcpUrl, namespace, newStoreSecrets, storeBootstrapJob, storeDatabase, storeMcp, storeSecrets, storeWeb,
  type Env, type Row, type StoreSecrets,
} from './manifests.js';

const log = (o: Record<string, unknown>, msg: string) => console.log(JSON.stringify({ time: new Date().toISOString(), svc: 'provisioner', ...o, msg }));
class Aborted extends Error {}
class Wait extends Error {} // not done yet: try again on the next tick

interface DbRow extends Row { status: string; step: string | null; secret: string | null; timeout_s: number; started_at: Date; attempts: number }

export class Reconciler {
  private running = new Set<number>();
  private sealer: ReturnType<typeof makeSealer>;
  constructor(private db: pg.Pool, private e: Env, credentialKey: string) { this.sealer = makeSealer(credentialKey); }

  /** One pass over everything in flight; each resource runs on its own, so several stores provision in parallel. */
  async tick() {
    const { rows } = await this.db.query<DbRow>(`select id::int as id, kind, slug, name, owner_id::int as owner_id, namespace, spec, status, step, secret,
      timeout_s, started_at, attempts from provisions where status in ('provisioning', 'deleting') order by id`);
    await Promise.all(rows.map((r) => this.run(r)));
  }

  private async run(r: DbRow) {
    if (this.running.has(r.id)) return;
    this.running.add(r.id);
    try {
      if (r.status === 'deleting') await this.remove(r);
      else await this.provision(r);
    } catch (e) {
      if (e instanceof Wait || e instanceof Aborted) return;
      // transient (API hiccup, conflict): note it and keep going until the timeout decides
      log({ id: r.id, slug: r.slug, err: (e as Error).message }, 'reconcile error');
      await this.db.query(`update provisions set reason = $2, updated_at = now() where id = $1 and status = $3`, [r.id, `retrying: ${(e as Error).message.slice(0, 300)}`, r.status]);
    } finally {
      this.running.delete(r.id);
    }
  }

  /** Record the current step; false (-> abort) if the row changed status meanwhile (e.g. the user deleted it). */
  private async step(r: DbRow, step: string) {
    if (r.status === 'provisioning' && Date.now() - new Date(r.started_at).getTime() > r.timeout_s * 1000) {
      await this.fail(r, `timed out after ${r.timeout_s}s while ${r.step ?? step}`);
      throw new Aborted();
    }
    const { rowCount } = await this.db.query(`update provisions set step = $2, updated_at = now() where id = $1 and status = $3`, [r.id, step, r.status]);
    if (!rowCount) throw new Aborted();
    r.step = step;
  }
  private async fail(r: DbRow, reason: string) {
    log({ id: r.id, slug: r.slug, reason }, 'provisioning failed');
    await this.db.query(`update provisions set status = 'failed', reason = $2, attempts = attempts + 1, updated_at = now() where id = $1 and status = 'provisioning'`, [r.id, reason.slice(0, 1000)]);
  }

  // ---------------------------------------------------------------- provisioning
  private async provision(r: DbRow) {
    await this.step(r, 'creating the namespace');
    const ns = await kube.get('Namespace', undefined, r.namespace);
    if (ns && ns.metadata?.labels?.[MANAGED_LABEL] !== MANAGED_VALUE) {
      await this.fail(r, `namespace ${r.namespace} already exists and is not managed by Urumi`);
      return;
    }
    if (ns?.status?.phase === 'Terminating') { await this.step(r, 'waiting for the previous namespace to finish deleting'); throw new Wait(); }
    await kube.apply(namespace(this.e, r));

    await this.step(r, 'applying quota, limits and network policies');
    for (const o of guardrails(this.e, r)) await kube.apply(o);

    if (r.kind === 'store') await this.provisionStore(r);
    else await this.provisionHosted(r);

    await this.step(r, 'registering the MCP server in the gateway');
    await this.register(r);
    await this.db.query(`update provisions set status = 'ready', step = 'ready', reason = null, ready_at = now(), updated_at = now() where id = $1 and status = 'provisioning'`, [r.id]);
    log({ id: r.id, slug: r.slug, kind: r.kind }, 'ready');
  }

  private async storeSecretsOf(r: DbRow): Promise<StoreSecrets> {
    if (r.secret) return JSON.parse(this.sealer.unseal(r.secret)!);
    // generated once; `where secret is null` keeps the first value if two runs ever raced
    await this.db.query('update provisions set secret = $2 where id = $1 and secret is null', [r.id, this.sealer.seal(JSON.stringify(newStoreSecrets()))]);
    const { rows } = await this.db.query('select secret from provisions where id = $1', [r.id]);
    r.secret = rows[0].secret;
    return JSON.parse(this.sealer.unseal(r.secret)!);
  }

  private async provisionStore(r: DbRow) {
    await this.step(r, 'creating secrets');
    for (const o of storeSecrets(r, await this.storeSecretsOf(r))) await kube.apply(o);
    await this.step(r, 'deploying the database and WordPress');
    for (const o of [...storeDatabase(this.e, r), ...storeWeb(this.e, r), ...storeMcp(this.e, r)]) await kube.apply(o);
    // one bootstrap Job per attempt (a retry after a failure starts a fresh one)
    const job = storeBootstrapJob(this.e, r, r.attempts);
    await kube.createIfAbsent(job);

    await this.step(r, 'waiting for the store bootstrap (database, WooCommerce setup)');
    const j = await kube.get('Job', r.namespace, job.metadata.name);
    const cond = (t: string) => j?.status?.conditions?.find((c: any) => c.type === t && c.status === 'True');
    if (cond('Failed')) {
      const pods = await kube.list('Pod', r.namespace, `job-name=${job.metadata.name}`).catch(() => []);
      const tail = pods.length ? (await kube.log(r.namespace, pods[pods.length - 1].metadata.name, 8)).trim().split('\n').slice(-4).join(' | ') : '';
      await this.fail(r, `store bootstrap failed (${cond('Failed').reason ?? 'BackoffLimitExceeded'})${tail ? `: ${tail}` : ''}`);
      throw new Aborted();
    }
    await this.problems(r);
    if (!cond('Complete')) throw new Wait();
    await this.step(r, 'waiting for the store and its MCP server to be ready');
    await this.available(r, ['mariadb', 'wordpress', 'woo-mcp']);
  }

  private async provisionHosted(r: DbRow) {
    await this.step(r, 'deploying the MCP server');
    const secretEnv = r.secret ? JSON.parse(this.sealer.unseal(r.secret)!) : {};
    for (const o of hostedServer(this.e, r, secretEnv)) await kube.apply(o);
    await this.step(r, 'waiting for the MCP server to be ready');
    await this.available(r, ['mcp']);
  }

  /** Every Deployment has a ready pod; otherwise report a permanent problem, or wait. */
  private async available(r: DbRow, names: string[]) {
    for (const name of names) {
      const d = await kube.get('Deployment', r.namespace, name);
      const failure = d?.status?.conditions?.find((c: any) => c.type === 'ReplicaFailure' && c.status === 'True');
      if (failure) { await this.fail(r, `${name}: ${failure.message}`); throw new Aborted(); } // quota / Pod Security refused the pod
      if (!(d?.status?.availableReplicas >= 1)) { await this.problems(r); throw new Wait(); }
    }
  }

  /** Permanent pod problems fail fast instead of waiting for the timeout. */
  private async problems(r: DbRow) {
    const pods = await kube.list('Pod', r.namespace).catch(() => [] as any[]);
    for (const p of pods) {
      for (const cs of [...(p.status?.initContainerStatuses ?? []), ...(p.status?.containerStatuses ?? [])]) {
        const w = cs.state?.waiting;
        if (w && ['ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'ErrImageNeverPull'].includes(w.reason)) {
          await this.fail(r, `${p.metadata.labels?.app ?? p.metadata.name}: ${w.reason}${w.message ? `: ${String(w.message).slice(0, 300)}` : ''}`);
          throw new Aborted();
        }
        if (w?.reason === 'CrashLoopBackOff' && cs.restartCount >= 3) {
          const tail = (await kube.log(r.namespace, p.metadata.name, 8)).trim().split('\n').slice(-3).join(' | ');
          await this.fail(r, `${p.metadata.labels?.app ?? p.metadata.name} keeps crashing (${cs.restartCount} restarts)${tail ? `: ${tail}` : ''}`);
          throw new Aborted();
        }
      }
      const unsched = p.status?.conditions?.find((c: any) => c.type === 'PodScheduled' && c.status === 'False');
      if (unsched && /Insufficient|didn't match/.test(unsched.message ?? '')) await this.db.query(`update provisions set reason = $2 where id = $1`, [r.id, `waiting: ${unsched.message}`]);
    }
  }

  /** Register (or refresh) the managed upstream and tell every gateway replica. */
  private async register(r: DbRow) {
    const managed = `provision:${r.id}`;
    const credential = r.kind === 'store' ? this.sealer.seal(`Bearer ${(await this.storeSecretsOf(r)).mcpToken}`) : null;
    const { rows } = await this.db.query(`insert into upstreams(slug, name, url, auth_header, credential, managed_by, timeout_ms)
      values ($1, $2, $3, $4, $5, $6, null)
      on conflict (slug) do update set name = excluded.name, url = excluded.url, auth_header = excluded.auth_header, credential = excluded.credential
        where upstreams.managed_by = excluded.managed_by
      returning id::int as id`, [r.slug, r.name, mcpUrl(r), credential ? 'Authorization' : null, credential, managed]);
    if (!rows.length) { await this.fail(r, `the name "${r.slug}" is already used by a registered MCP server`); throw new Aborted(); }
    await this.notify(rows[0].id);
  }
  private notify = (id: number) => this.db.query('select pg_notify($1, $2)', ['urumi_events', JSON.stringify({ t: 'upstream', id, from: 'provisioner' })]);

  // ---------------------------------------------------------------- teardown
  private async remove(r: DbRow) {
    await this.step(r, 'removing the MCP registration');
    const { rows } = await this.db.query(`delete from upstreams where managed_by = $1 returning id::int as id`, [`provision:${r.id}`]);
    for (const x of rows) await this.notify(x.id);
    await this.step(r, 'deleting the namespace (volumes, secrets, ingress)');
    const ns = await kube.get('Namespace', undefined, r.namespace);
    if (ns && ns.metadata?.labels?.[MANAGED_LABEL] === MANAGED_VALUE && ns.metadata?.labels?.['urumi.ai/provision'] === String(r.id)) {
      if (ns.status?.phase !== 'Terminating') {
        try { await kube.del('Namespace', undefined, r.namespace, 'Foreground'); } catch (e) { if (!(e instanceof KubeError && e.status === 409)) throw e; }
      }
      await this.step(r, 'waiting for the namespace to be deleted');
      throw new Wait();
    }
    // gone (or never ours): forget it
    await this.db.query('delete from provisions where id = $1 and status = $2', [r.id, 'deleting']);
    log({ id: r.id, slug: r.slug }, 'deleted');
  }
}
