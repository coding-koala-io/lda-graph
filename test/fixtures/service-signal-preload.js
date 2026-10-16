import {Store} from '../../src/store.js';
// Keep writes pending until the actual CLI shutdown handler flushes them.
Store.prototype.changed = function () {};
process.on('message', message => {
  if (!['SIGBREAK', 'SIGINT', 'SIGTERM'].includes(message.signal)) throw new Error('Unexpected test signal');
  process.emit(message.signal);
  process.disconnect();
});
