import {readFileSync} from 'node:fs';

export const key = 'graph';
export const name = 'LDA Local Graph';
export const suite = 'Local Developer Accelerator for Optimizely';
export const publisher = 'Coding Koalas Pty Ltd';
export const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const dataVersion = 1;
export const compatibleWith = 'Optimizely Graph';
export const product = Object.freeze({key, name, suite, publisher, version, dataVersion, compatibleWith});
