#!/usr/bin/env node
const fs = require('node:fs');

const args = process.argv.slice(2);
if (!args.includes('-p') || !args.includes('json') || !args.includes('auto')) process.exit(91);
const path = process.env.AFK_COUNT;
const count = Number(fs.existsSync(path) ? fs.readFileSync(path, 'utf8') : '0') + 1;
fs.writeFileSync(path, String(count));
for (const line of JSON.parse(process.env.AFK_DIAGNOSTICS || '[]')) process.stderr.write(`${line}\n`);
const scenarios = JSON.parse(process.env.AFK_SCENARIOS);
const scenario = scenarios[Math.min(count - 1, scenarios.length - 1)];
if (scenario === 'exit') process.exit(7);
if (scenario === 'hang') {
  process.stderr.write('hidden diagnostic\n');
  fs.writeFileSync(process.env.AFK_READY, String(process.pid));
  setInterval(() => {}, 1000);
} else if (scenario !== 'missing') {
  const response = scenario === 'violation' ? 'not protocol' : JSON.stringify(
    scenario === 'blocked' ? { outcome: scenario, blocker_text: 'needs input' }
      : scenario === 'fail' ? { outcome: scenario, failure_summary: 'failed task' }
        : { outcome: scenario },
  );
  process.stdout.write(JSON.stringify({ result: response }));
}
