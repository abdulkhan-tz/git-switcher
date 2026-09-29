import { useState, type FormEvent } from 'react';
import { api } from '../api';

export function AddRepo({ onAdded, onError }: { onAdded(): void; onError(message: string): void }) {
  const [open, setOpen] = useState(false);
  const [path, setPath] = useState('');
  const [name, setName] = useState('');
  const [base, setBase] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.addRepo({ path: path.trim(), name: name.trim() || undefined, base: base.trim() || undefined });
      setPath('');
      setName('');
      setBase('');
      setOpen(false);
      onAdded();
    } catch (err) {
      onError((err as Error).message);
    }
  };

  if (!open) return <button onClick={() => setOpen(true)}>+ Add repo</button>;
  return (
    <form className="add-repo" onSubmit={submit}>
      <input autoFocus required value={path} onChange={(e) => setPath(e.target.value)} placeholder="/absolute/path/to/repo" aria-label="Repo path" />
      <input value={name} onChange={(e) => setName(e.target.value)} placeholder="name (optional)" aria-label="Name" />
      <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="base, e.g. origin/develop" aria-label="Base" />
      <button type="submit" className="primary">Add</button>
      <button type="button" className="ghost" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}
