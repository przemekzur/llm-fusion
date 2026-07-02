export function addItem(items, title) {
  const trimmed = title.trim();
  if (!trimmed) throw new Error("Title must not be empty");
  const nextId = items.reduce((max, item) => Math.max(max, item.id), 0) + 1;
  const item = { id: nextId, title: trimmed, done: false };
  items.push(item);
  return item;
}

export function stats(items) {
  return {
    total: items.length,
    done: items.filter((item) => item.done).length,
    remaining: items.filter((item) => !item.done).length,
  };
}
