import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { isIP, BlockList } from 'node:net';

export const LIST = 'bypass_cloudflare_for_github_action_list';
const PHASE = 'http_request_firewall_custom';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export function inputs(env = process.env) {
  const get = name => (env[`INPUT_${name.toUpperCase()}`] || '').trim();
  const bool = name => {
    const value = get(name) || 'false';
    if (!['true', 'false'].includes(value)) throw new Error(`Invalid ${name}`);
    return value === 'true';
  };
  const config = { account: get('cf_account_id'), zone: get('cf_zone_id'), token: get('cf_api_token'),
    disable: bool('disable_bot_fight_mode'), bic: bool('skip_bic'),
    hostname: get('hostname').toLowerCase(), path: get('path_prefix'), delay: get('bfm_propagation_delay') || '10' };
  if (!/^[a-f0-9]{32}$/i.test(config.account) || !/^[a-f0-9]{32}$/i.test(config.zone) || !config.token) throw new Error('Missing or invalid Cloudflare credentials');
  if (config.hostname && (config.hostname.length > 253 || !config.hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)))) throw new Error('hostname must be an exact DNS hostname');
  if (config.path && (!config.path.startsWith('/') || /[\x00-\x20\x7f"\\?#]/.test(config.path))) throw new Error('path_prefix must be an absolute URL path without query, fragment or escaping');
  if (!/^\d+$/.test(config.delay) || Number(config.delay) > 300) throw new Error('bfm_propagation_delay must be 0–300 seconds');
  config.delay = Number(config.delay);
  return config;
}

export function expression(config, ip) {
  if (!isIP(ip)) throw new Error('Invalid runner IP');
  return [`ip.src in $${LIST}`, `ip.src eq ${ip}`, ...(config.hostname ? [`http.host eq ${JSON.stringify(config.hostname)}`] : []), ...(config.path ? [`starts_with(http.request.uri.path, ${JSON.stringify(config.path)})`] : [])].map(part => `(${part})`).join(' and ');
}

function includesIP(item, ip) {
  const [address, prefix] = item.ip.split('/');
  const family = isIP(address) === 4 ? 'ipv4' : 'ipv6';
  const block = new BlockList();
  if (prefix === undefined) block.addAddress(address, family);
  else block.addSubnet(address, Number(prefix), family);
  return block.check(ip, isIP(ip) === 4 ? 'ipv4' : 'ipv6');
}

function exactIP(item, ip) {
  const prefix = item.ip.split('/')[1];
  return includesIP(item, ip) && (prefix === undefined || Number(prefix) === (isIP(ip) === 4 ? 32 : 128));
}

export class Client {
  constructor(token, fetcher = fetch) { this.token = token; this.fetcher = fetcher; }
  async request(method, path, body, allow404 = false) {
    let response;
    try {
      response = await this.fetcher(`https://api.cloudflare.com/client/v4${path}`, {
        method, headers: { Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(15000), redirect: 'error'
      });
    } catch { throw new Error(`Cloudflare ${method} request failed or timed out`); }
    if (allow404 && response.status === 404) return null;
    let data;
    try { data = await response.json(); } catch { throw new Error(`Cloudflare ${method}: invalid JSON (HTTP ${response.status})`); }
    if (!response.ok || data.success !== true) throw new Error(`Cloudflare ${method} failed (HTTP ${response.status})`);
    return data;
  }
}

export function saveState(state) {
  if (!process.env.GITHUB_STATE) throw new Error('Missing GitHub state file');
  appendFileSync(process.env.GITHUB_STATE, `bypass=${JSON.stringify(state)}\n`);
}

export class Bypass {
  constructor(config, { client = new Client(config.token), save = saveState, wait = sleep, fetcher = fetch, state = {} } = {}) {
    this.config = config; this.client = client; this.save = save; this.wait = wait; this.fetcher = fetcher; this.state = state;
    this.account = `/accounts/${config.account}/rules/lists`;
    this.zone = `/zones/${config.zone}`;
  }
  checkpoint(change) { Object.assign(this.state, change); this.save(this.state); }
  async api(method, path, body, allow404) { return this.client.request(method, path, body, allow404); }
  async items() {
    const all = []; let cursor = ''; const seen = new Set();
    do {
      // Cloudflare's List Items endpoint caps per_page at 500.
      const data = await this.api('GET', `${this.account}/${this.state.list}/items?per_page=500${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      if (!Array.isArray(data.result)) throw new Error('Invalid list items response');
      all.push(...data.result); cursor = data.result_info?.cursors?.after || '';
      if (cursor && seen.has(cursor)) throw new Error('Repeated list pagination cursor');
      seen.add(cursor);
      if (seen.size > 1000) throw new Error('List pagination limit exceeded');
    } while (cursor);
    return all;
  }
  async bulk(data, kind) {
    const id = data?.result?.operation_id;
    if (!id) throw new Error('Missing list operation ID');
    this.checkpoint({ operation: { id, kind } });
    for (let i = 0; i < 30; i++) {
      const result = (await this.api('GET', `${this.account}/bulk_operations/${id}`)).result;
      if (result.status === 'completed') {
        this.checkpoint({ operation: null, ...(kind === 'append' ? { itemWriteCompleted: true } : {}) });
        return;
      }
      if (result.status === 'failed') {
        // Terminal failure cannot add more items later; still inspect partial results.
        this.checkpoint({ operation: null, ...(kind === 'append' ? { itemWriteCompleted: true } : {}) });
        throw new Error('Cloudflare list operation failed');
      }
      await this.wait(1000);
    }
    throw new Error('Cloudflare list operation timed out');
  }
  async entrypoint() { return (await this.api('GET', `${this.zone}/rulesets/phases/${PHASE}/entrypoint`, undefined, true))?.result; }
  async run() {
    try {
      let ipResponse;
      try { ipResponse = await this.fetcher('https://api.ipify.org', { signal: AbortSignal.timeout(15000), redirect: 'error' }); } catch { throw new Error('Runner IP lookup failed'); }
      const ip = (await ipResponse.text()).trim();
      if (!ipResponse.ok || !isIP(ip)) throw new Error('Invalid runner IP response');
      this.checkpoint({ owner: `scoped-gha:${randomUUID()}`, ip });
      console.log(`Temporary resource ownership: ${this.state.owner}`);
      let entry = await this.entrypoint();
      // Never silently weaken a caller's scope with an older broad rule.
      if ((entry?.rules || []).some(rule => rule.enabled !== false && rule.expression?.includes(`$${LIST}`) && !this.isScopedRule(rule))) throw new Error('Existing broad rule references the shared list; migrate it manually first');
      const lists = (await this.api('GET', this.account)).result;
      let list = lists.find(item => item.name === LIST);
      if (!list) list = (await this.api('POST', this.account, { name: LIST, kind: 'ip', description: 'Shared scoped GitHub Actions runner list; retained empty after use' })).result;
      if (!list?.id || list.kind !== 'ip') throw new Error('Invalid shared IP list');
      this.checkpoint({ list: list.id });
      if ((await this.items()).some(item => includesIP(item, ip))) throw new Error('Runner IP already present; serialize jobs sharing an egress IP');
      this.checkpoint({ itemPending: true });
      await this.bulk(await this.api('POST', `${this.account}/${list.id}/items`, [{ ip, comment: this.state.owner }]), 'append');
      const owned = (await this.items()).filter(item => item.comment === this.state.owner);
      if (owned.length !== 1 || !exactIP(owned[0], ip)) throw new Error('Could not verify owned runner IP');
      const parameters = { phases: ['http_request_firewall_managed', 'http_ratelimit', 'http_request_sbfm'], ruleset: 'current', ...(this.config.bic ? { products: ['bic'] } : {}) };
      const rule = { description: this.state.owner, expression: expression(this.config, ip), action: 'skip', action_parameters: parameters, logging: { enabled: true }, enabled: true };
      this.checkpoint({ rulePending: true });
      if (entry) await this.api('POST', `${this.zone}/rulesets/${entry.id}/rules`, { ...rule, position: { index: 1 } });
      else await this.api('POST', `${this.zone}/rulesets`, { kind: 'zone', name: 'default', phase: PHASE, rules: [rule] });
      this.checkpoint({ ruleWriteCompleted: true });
      entry = await this.entrypoint();
      if (!(entry?.rules || []).some(item => item.description === this.state.owner && item.expression === rule.expression)) throw new Error('Could not verify temporary rule');
      if (this.config.disable) {
        const original = (await this.api('GET', `${this.zone}/bot_management`)).result;
        if (original.fight_mode !== true || typeof original.enable_js !== 'boolean') throw new Error('BFM must already be enabled with readable JS setting; do not overlap zone-wide bypass jobs');
        this.checkpoint({ bfm: { fight_mode: original.fight_mode, enable_js: original.enable_js }, restorePending: true });
        await this.api('PUT', `${this.zone}/bot_management`, { fight_mode: false, enable_js: original.enable_js });
        if ((await this.api('GET', `${this.zone}/bot_management`)).result.fight_mode !== false) throw new Error('BFM disable verification failed');
        await this.wait(this.config.delay * 1000);
      }
    } catch (error) {
      try { await this.cleanup(); } catch { throw new Error(`${error.message}; cleanup incomplete; post cleanup will retry`); }
      throw error;
    }
  }
  isScopedRule(rule) {
    if (!/^scoped-gha:[a-f0-9-]{36}$/.test(rule.description || '')) return false;
    const match = rule.expression?.match(/^\(ip\.src in \$bypass_cloudflare_for_github_action_list\) and \(ip\.src eq ([0-9a-fA-F:.]+)\)(.*)$/);
    return Boolean(match && isIP(match[1]) && (!match[2] || /^ and \(http\.host eq "[a-z0-9.-]+"\)(?: and \(starts_with\(http\.request\.uri\.path, "[^"\\]+"\)\))?$/.test(match[2]) || /^ and \(starts_with\(http\.request\.uri\.path, "[^"\\]+"\)\)$/.test(match[2])));
  }
  async cleanup() {
    const failures = [];
    if (this.state.restorePending) {
      let restored = false;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await this.api('PUT', `${this.zone}/bot_management`, this.state.bfm);
          const actual = (await this.api('GET', `${this.zone}/bot_management`)).result;
          if (actual.fight_mode !== this.state.bfm.fight_mode || actual.enable_js !== this.state.bfm.enable_js) throw new Error('BFM restoration mismatch');
          this.checkpoint({ restorePending: false }); restored = true; break;
        } catch { if (attempt < 2) await this.wait(1000); }
      }
      if (!restored) failures.push('BFM restore failed: restore saved settings manually');
    }
    if (this.state.rulePending) {
      try {
        const entry = await this.entrypoint();
        for (const rule of entry?.rules || []) if (rule.description === this.state.owner) {
          if (rule.expression !== expression(this.config, this.state.ip)) throw new Error('Owned rule was modified; manual review required');
          this.checkpoint({ ruleWriteCompleted: true });
          await this.api('DELETE', `${this.zone}/rulesets/${entry.id}/rules/${rule.id}`, undefined, true);
        }
        if (((await this.entrypoint())?.rules || []).some(rule => rule.description === this.state.owner)) throw new Error('Rule still present');
        if (!this.state.ruleWriteCompleted) throw new Error('Unknown rule write outcome; retain post-job retry state');
        this.checkpoint({ rulePending: false });
      } catch { failures.push('temporary rule cleanup failed'); }
    }
    if (this.state.itemPending && this.state.list) {
      try {
        if (this.state.operation) {
          try { await this.bulk({ result: { operation_id: this.state.operation.id } }, this.state.operation.kind); }
          catch (error) { if (this.state.operation) throw error; }
        }
        // Unique comment recovers ownership even when the write response was lost.
        // A lost asynchronous write response may become visible later. Observe for
        // a bounded window rather than treating the first empty read as success.
        for (let attempt = 0; attempt < (this.state.itemWriteCompleted ? 2 : 30); attempt++) {
          const owned = (await this.items()).filter(item => item.comment === this.state.owner);
          if (owned.length) {
            if (owned.some(item => !exactIP(item, this.state.ip))) throw new Error('Owned IP was modified; manual review required');
            await this.bulk(await this.api('DELETE', `${this.account}/${this.state.list}/items`, { items: owned.map(item => ({ id: item.id })) }), 'delete');
            this.checkpoint({ itemWriteCompleted: true });
          }
          await this.wait(1000);
        }
        if ((await this.items()).some(item => item.comment === this.state.owner)) throw new Error('Owned IP still present');
        if (this.state.itemWriteCompleted) this.checkpoint({ itemPending: false });
        else throw new Error('Unknown asynchronous write outcome; retain post-job retry state');
      } catch { failures.push('owned IP cleanup failed'); }
    }
    if (failures.length) throw new Error(failures.join('; '));
  }
}
