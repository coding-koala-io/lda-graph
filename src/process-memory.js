import {getHeapStatistics} from 'node:v8';

/** Byte values, shared by authenticated health and dashboard diagnostics. */
export function processMemory() {
  const {heapUsed, rss} = process.memoryUsage();
  return {heapUsed, heapLimit: getHeapStatistics().heap_size_limit, rss};
}
