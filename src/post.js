import { Bypass, inputs } from './runtime.js';
try {
  const state = JSON.parse(process.env.STATE_bypass || '{}');
  if (state.owner) {
    await new Bypass(inputs(), { state }).cleanup();
    console.log('BFM restored where changed; owned temporary rule and IP removed.');
  }
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
