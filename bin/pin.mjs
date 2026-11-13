#!/usr/bin/env node
// npm run pin: records, in ENGINE, the agent-neuron commit this repo's tests
// last passed on. A record, not a requirement: this repo follows the engine in
// the sibling checkout, and nothing compares the two while it runs.
// It builds that engine (unless NEURON_ENGINE names one), runs `npm run check`,
// and writes the commit only when that passes on an engine built from a clean commit.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const agentNeuron = path.resolve(process.env.AGENT_NEURON_ROOT ?? path.join(here, '../agent-neuron'));
const engine = path.resolve(process.env.NEURON_ENGINE ?? path.join(agentNeuron, 'rust-engine/target/debug/neuron-engine'));
const stop = (why) => {
  console.error(`Not pinning: ${why}`);
  process.exit(1);
};

if (!process.env.NEURON_ENGINE) {
  const built = spawnSync('cargo', ['build', '--manifest-path', path.join(agentNeuron, 'rust-engine/Cargo.toml')], { stdio: 'inherit' });
  if (built.status !== 0) stop('cargo build failed.');
}

// `neuron-engine 0.0.0 <commit>[-dirty]`
const out = spawnSync(engine, ['--version'], { encoding: 'utf8' });
const words = out.status === 0 ? out.stdout.trim().split(' ') : [];
const commit = words.length === 3 && words[0] === 'neuron-engine' ? words[2] : null;
if (!commit) stop(`${engine} does not answer --version.`);
if (commit === 'unknown' || commit.endsWith('-dirty')) stop(`the engine reports ${commit}; pin one built from a clean commit.`);

const tests = spawnSync('npm', ['run', 'check'], { cwd: here, stdio: 'inherit' });
if (tests.status !== 0) stop(`\`npm run check\` failed on ${commit.slice(0, 7)}.`);

fs.writeFileSync(
  path.join(here, 'ENGINE'),
  `# The agent-neuron commit this repo's tests last passed on (npm run pin writes it).\n${commit}\n`,
);
console.log(`ENGINE = ${commit}`);
