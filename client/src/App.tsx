import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { APP_NAME } from '../../shared/appName';
import { Button, Spinner } from './components/ui';
import Backup from './pages/Backup';
import BulkImport from './pages/BulkImport';
import Calendar from './pages/Calendar';
import Folders from './pages/Folders';
import Login from './pages/Login';
import Milestones from './pages/Milestones';
import Settings from './pages/Settings';
import Timeline from './pages/Timeline';
import Trash from './pages/Trash';
import Upload from './pages/Upload';
import Wizard from './pages/Wizard';
import { useAppState } from './state';

const NAV = [
  { to: '/', label: 'Timeline', icon: '🏠' },
  { to: '/calendar', label: 'Calendar', icon: '📅' },
  { to: '/upload', label: 'Upload', icon: '⬆️' },
  { to: '/milestones', label: 'Milestones', icon: '⭐' },
  { to: '/more', label: 'More', icon: '⋯' },
];

export default function App() {
  const { status, loading, unreachable, needsLogin, refresh } = useAppState();

  if (unreachable) {
    return (
      <Center>
        <div className="text-5xl">📡</div>
        <h1 className="text-xl font-semibold text-slate-100">Can't reach {APP_NAME}</h1>
        <p className="max-w-sm text-center text-sm text-slate-400">
          The server isn't answering. Check that it's running on your PC or NAS and that you're on the same Wi-Fi network.
        </p>
        <Button onClick={() => void refresh()}>Try again</Button>
      </Center>
    );
  }

  if (loading && !status) {
    return (
      <Center>
        <Spinner label={`Starting ${APP_NAME}…`} />
      </Center>
    );
  }

  if (needsLogin) return <Login />;
  if (status?.needsSetup) return <Wizard />;

  return (
    <div className="min-h-dvh bg-slate-950 pb-20 text-slate-100 md:pb-0 md:pl-52">
      <aside className="fixed inset-x-0 bottom-0 z-40 border-t border-slate-800 bg-slate-900/95 backdrop-blur md:inset-y-0 md:left-0 md:w-52 md:border-r md:border-t-0">
        <div className="hidden items-center gap-2 p-4 md:flex">
          <img src="/icon.svg" alt="" className="h-8 w-8" />
          <span className="text-lg font-bold">{APP_NAME}</span>
        </div>
        <nav className="flex justify-around md:mt-2 md:flex-col md:justify-start md:gap-1 md:px-2">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to === '/more' ? '/settings' : item.to}
              end={item.to === '/'}
              className={({ isActive }) =>
                `flex flex-col items-center gap-0.5 px-3 py-2 text-[11px] font-medium md:flex-row md:gap-3 md:rounded-lg md:px-3 md:text-sm ${
                  isActive ? 'text-pink-400 md:bg-slate-800' : 'text-slate-400 hover:text-slate-200'
                }`
              }
            >
              <span className="text-lg md:text-base">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <main className="mx-auto max-w-5xl px-3 py-4 md:px-6">
        <Routes>
          <Route path="/" element={<Timeline />} />
          <Route path="/calendar" element={<Calendar />} />
          <Route path="/upload" element={<Upload />} />
          <Route path="/milestones" element={<Milestones />} />
          <Route path="/folders" element={<Folders />} />
          <Route path="/import" element={<BulkImport />} />
          <Route path="/backup" element={<Backup />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/trash" element={<Trash />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
    </div>
  );
}

function Center({ children }: { children: React.ReactNode }) {
  return <div className="flex min-h-dvh flex-col items-center justify-center gap-4 bg-slate-950 p-6">{children}</div>;
}
