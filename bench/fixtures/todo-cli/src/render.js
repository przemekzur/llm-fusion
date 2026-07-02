export function renderLine(item) {
  const box = item.done ? "[x]" : "[ ]";
  return `${box} #${item.id} ${item.title}`;
}

export function renderStats(counts) {
  return `${counts.done}/${counts.total} done, ${counts.remaining} remaining`;
}
