import { useEffect, useState } from 'react';

interface Item { id: number; text: string; kind: 'ok' | 'error' }
let items: Item[] = [];
let next = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Shows a short message in the corner. Callable from anywhere; <Toaster/> renders them. */
export function toast(text: string, kind: Item['kind'] = 'ok') {
  const id = next++;
  items = [...items, { id, text, kind }];
  emit();
  setTimeout(() => {
    items = items.filter((i) => i.id !== id);
    emit();
  }, kind === 'error' ? 6000 : 2800);
}

export function Toaster() {
  const [, tick] = useState(0);
  useEffect(() => {
    const l = () => tick((n) => n + 1);
    listeners.add(l);
    return () => void listeners.delete(l);
  }, []);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {items.map((i) => <div key={i.id} className={`toast ${i.kind === 'error' ? 'error' : ''}`}>{i.text}</div>)}
    </div>
  );
}
