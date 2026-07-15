import { Link } from 'react-router-dom';

const ITEMS = [
  { to: '/milestones', icon: '⭐', title: 'Milestones', desc: 'First steps, first words — in age order' },
  { to: '/folders', icon: '🗂️', title: 'Folders', desc: 'Browse the real folder tree on disk' },
  { to: '/import', icon: '📥', title: 'Bulk import', desc: 'Import an old photo/video export from a folder' },
  { to: '/backup', icon: '🛟', title: 'Backup', desc: 'Mirror your library to USB, NAS or Google Drive' },
  { to: '/trash', icon: '🗑️', title: 'Trash', desc: 'Deleted items, kept 30 days' },
  { to: '/settings', icon: '⚙️', title: 'Settings', desc: 'Children, password, disk & backup status, export/import' },
];

export default function More() {
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold text-slate-100">More</h1>
      <div className="grid gap-2 sm:grid-cols-2">
        {ITEMS.map((item) => (
          <Link
            key={item.to}
            to={item.to}
            className="flex items-start gap-3 rounded-xl border border-slate-800 bg-slate-900/60 p-4 transition hover:border-slate-600"
          >
            <span className="text-2xl">{item.icon}</span>
            <span>
              <span className="block font-semibold text-slate-100">{item.title}</span>
              <span className="block text-sm text-slate-400">{item.desc}</span>
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}
