import {randomBytes} from 'node:crypto';

/** Generate inside the registry write queue, against its latest entries. */
export function generateTenant(name, entries, random = randomBytes, isTaken = () => false) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) throw new Error('Name is required and must be 1-100 characters after trimming');
  name = name.trim();
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40).replace(/-+$/g, '') || 'instance';
  const ids = new Set(entries.map(entry => entry.id));
  let id = slug;
  for (let suffix = 2; ids.has(id) || isTaken(id); suffix++) id = `${slug}-${suffix}`;
  const keys = new Set(entries.flatMap(entry => [entry.appKey, entry.singleKey]));
  const key = prefix => {
    let value;
    do { value = `${prefix}-${id}-${random(4).toString('hex')}`; } while (keys.has(value));
    keys.add(value); return value;
  };
  return {id, name, appKey: key('app'), singleKey: key('pub'), secret: random(32).toString('base64')};
}
