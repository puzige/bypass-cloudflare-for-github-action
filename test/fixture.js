import { LIST } from '../src/runtime.js';

export function initial() {
  return { items: [{ id: 'foreign', ip: '198.51.100.8', comment: 'leave me alone' }],
    rules: [{ id: 'foreign-rule', description: 'unrelated', expression: 'true', action: 'log' }],
    bfm: { fight_mode: true, enable_js: false }, calls: [], listExists: true, entryExists: true };
}

export function fakeFetch(state, { fail = () => false, lost = () => false } = {}) {
  return async (url, options = {}) => {
    const method = options.method || 'GET';
    if (url === 'https://api.ipify.org') {
      if (options.headers?.Authorization) throw new Error('Token sent to IP service');
      return new Response(state.ip || '203.0.113.7');
    }
    const parsed = new URL(url);
    if (parsed.origin !== 'https://api.cloudflare.com') throw new Error('Unexpected network request');
    const path = parsed.pathname;
    const body = options.body ? JSON.parse(options.body) : undefined;
    const call = { method, path, body }; state.calls.push(call);
    if (fail(call)) return Response.json({ success: false, errors: [{ message: 'must-not-log-response-secret' }] });
    let result;
    if (path.endsWith('/bot_management')) {
      if (method === 'PUT') Object.assign(state.bfm, body);
      result = state.bfm;
    } else if (path.includes('/bulk_operations/')) result = { status: 'completed' };
    else if (path.endsWith('/items')) {
      if (method === 'GET') {
        const page = parsed.searchParams.get('cursor');
        if (state.paginate && !page) return Response.json({ success: true, result: state.items.slice(0, 1), result_info: { cursors: { after: 'page2' } } });
        result = state.paginate ? state.items.slice(1) : state.items;
      } else if (method === 'POST') {
        state.items.push(...body.map((item, i) => ({ id: `owned-${i}`, ...item })));
        result = { operation_id: 'op' };
      } else if (method === 'DELETE') {
        state.items = state.items.filter(item => !body.items.some(remove => remove.id === item.id)); result = { operation_id: 'op' };
      } else throw new Error('Unsafe list operation');
    } else if (path.endsWith('/rules/lists')) {
      const list = { id: 'list', kind: 'ip', name: LIST };
      if (method === 'GET') result = state.listExists ? [list] : [];
      else { state.listExists = true; result = list; }
    } else if (path.endsWith('/entrypoint')) {
      if (!state.entryExists) return Response.json({ success: false }, { status: 404 });
      result = { id: 'ruleset', rules: state.rules };
    } else if (path.endsWith('/rulesets') && method === 'POST') {
      state.entryExists = true; state.rules.push(...body.rules.map(rule => ({ id: 'owned-rule', ...rule })));
      result = { id: 'ruleset', rules: state.rules };
    } else if (path.endsWith('/rules') && method === 'POST') {
      state.rules.push({ id: 'owned-rule', ...body }); result = { id: 'ruleset', rules: state.rules };
    } else if (path.includes('/rulesets/ruleset/rules/') && method === 'DELETE') {
      state.rules = state.rules.filter(rule => rule.id !== path.split('/').at(-1)); result = { id: 'ruleset', rules: state.rules };
    } else throw new Error(`Unexpected fixture request: ${method} ${path}`);
    if (lost(call)) throw new Error('Response lost after applying write');
    return Response.json({ success: true, result });
  };
}
