import { Bypass, inputs } from './runtime.js';
try {
  await new Bypass(inputs()).run();
  console.log('Scoped bypass ready; post-job cleanup registered.');
} catch (error) {
  console.error(`::error::${error.message}`);
  process.exitCode = 1;
}
