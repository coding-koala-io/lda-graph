import {readFile} from 'node:fs/promises';
const [profileFile, phaseFile] = process.argv.slice(2);
const profile = JSON.parse(await readFile(profileFile, 'utf8'));
const phase = JSON.parse(await readFile(phaseFile, 'utf8'));
const nodes = new Map(profile.nodes.map(node => [node.id, node]));
const totals = new Map();
let time = profile.startTime;
for (let i = 0; i < profile.samples.length; i++) {
  const delta = profile.timeDeltas[i];
  time += delta;
  if (time < phase.start || time > phase.end) continue;
  const frame = nodes.get(profile.samples[i]).callFrame;
  const name = `${frame.functionName || '(anonymous)'} ${frame.url.split('/').at(-1)}:${frame.lineNumber + 1}`;
  totals.set(name, (totals.get(name) ?? 0) + delta / 1000);
}
console.log(JSON.stringify({profileFile, phaseMs: phase.ms, selfMs: [...totals].sort((a, b) => b[1] - a[1]).slice(0, 30)}, null, 2));
