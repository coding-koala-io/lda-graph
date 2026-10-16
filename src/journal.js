// Only per-operation IDs and outcomes are retained. Repeated wire wrappers,
// field names and the constant index name are reconstructed for inspection.
const results = ['created', 'updated', 'deleted', 'noop', 'not_found'];
const itemsProperty = {enumerable: true, configurable: true, get() {
  return JSON.parse(this.itemsJson).map(([id, status, result, error]) => ({index: {
    Status: status, _index: 'default', _id: id, Result: results[result] ?? result,
    ...(error === undefined ? {} : {Error: error}),
  }}));
}};

export function compactJournal(journal) {
  if (!Array.isArray(journal?.items)) return journal;
  // Historical/custom records with extra wire fields must round-trip verbatim.
  if (journal.items.some(item => !item?.index || Object.keys(item).some(key => key !== 'index') || item.index._index !== 'default' ||
    Object.keys(item.index).some(key => !['Status', '_index', '_id', 'Result', 'Error'].includes(key)))) return journal;
  const {items, ...summary} = journal;
  const packed = items.map(({index}) => [index._id, index.Status,
    results.includes(index.Result) ? results.indexOf(index.Result) : index.Result,
    ...(index.Error === undefined ? [] : [index.Error])]);
  Object.defineProperty(summary, 'itemsJson', {value: JSON.stringify(packed)});
  Object.defineProperty(summary, 'itemCount', {value: items.length});
  Object.defineProperty(summary, 'items', itemsProperty);
  return summary;
}
