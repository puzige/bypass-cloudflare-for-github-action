// Test-only fetch interception. The production action never accepts a custom API URL.
import { readFileSync, writeFileSync } from 'node:fs';
import { fakeFetch } from './fixture.js';
const filename = process.env.FIXTURE_STATE;
if (filename) {
  const state = JSON.parse(readFileSync(filename, 'utf8'));
  const fetcher = fakeFetch(state, { fail: call => process.env.FIXTURE_FAIL === 'rule' && call.method === 'POST' && call.path.endsWith('/rules') });
  globalThis.fetch = async (...args) => {
    try { return await fetcher(...args); }
    finally { writeFileSync(filename, JSON.stringify(state)); }
  };
}
