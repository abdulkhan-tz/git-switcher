import { useState, type FormEvent } from 'react';
import type { Group } from '@git-helper/core';

interface Props {
  groups: Group[];
  selectedCount: number;
  running: boolean;
  onSelectGroup(group: Group): void;
  onSelectAll(all: boolean): void;
  onSaveGroup(name: string): void;
  onDeleteGroup(name: string): void;
  onSwitch(branch: string, base?: string): void;
}

export function SwitchBar(p: Props) {
  const [branch, setBranch] = useState('');
  const [base, setBase] = useState('');
  const [groupName, setGroupName] = useState('');

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (branch.trim()) p.onSwitch(branch.trim(), base.trim() || undefined);
  };

  return (
    <section className="switchbar">
      <form onSubmit={submit} className="switch-form">
        <input className="branch-input" value={branch} onChange={(e) => setBranch(e.target.value)} placeholder="branch, e.g. feature/login" aria-label="Branch" />
        <input value={base} onChange={(e) => setBase(e.target.value)} placeholder="base override (optional)" aria-label="Base override" />
        <button type="submit" className="primary" disabled={!branch.trim() || p.selectedCount === 0 || p.running}>
          Switch {p.selectedCount} repo{p.selectedCount === 1 ? '' : 's'}
        </button>
      </form>
      <div className="groups">
        <button className="ghost small" onClick={() => p.onSelectAll(true)}>all</button>
        <button className="ghost small" onClick={() => p.onSelectAll(false)}>none</button>
        {p.groups.map((g) => (
          <span key={g.name} className="chip">
            <button onClick={() => p.onSelectGroup(g)} title="Select this group's repos">{g.name}</button>
            <button className="chip-x" onClick={() => confirm(`Delete group "${g.name}"?`) && p.onDeleteGroup(g.name)} aria-label={`Delete group ${g.name}`}>×</button>
          </span>
        ))}
        <form
          className="save-group"
          onSubmit={(e) => {
            e.preventDefault();
            if (groupName.trim()) p.onSaveGroup(groupName.trim());
            setGroupName('');
          }}
        >
          <input value={groupName} onChange={(e) => setGroupName(e.target.value)} placeholder="save selection as group" aria-label="Group name" disabled={p.selectedCount === 0} />
        </form>
      </div>
    </section>
  );
}
