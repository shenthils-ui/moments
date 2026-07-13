import { useAppState } from '../state';

export function ChildChips({ selected, onSelect }: { selected: string | null; onSelect: (id: string | null) => void }) {
  const { children } = useAppState();
  if (children.length < 2) return null;
  return (
    <div className="flex flex-wrap gap-2" data-testid="child-chips">
      <Chip label="Everyone" color="#94a3b8" active={selected === null} onClick={() => onSelect(null)} />
      {children.map((c) => (
        <Chip key={c.id} label={c.name} color={c.color} active={selected === c.id} onClick={() => onSelect(c.id)} />
      ))}
    </div>
  );
}

function Chip({ label, color, active, onClick }: { label: string; color: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs font-medium transition ${active ? 'text-slate-900' : 'text-slate-300 hover:bg-slate-800'}`}
      style={active ? { background: color, borderColor: color } : { borderColor: color + '66' }}
    >
      {label}
    </button>
  );
}
