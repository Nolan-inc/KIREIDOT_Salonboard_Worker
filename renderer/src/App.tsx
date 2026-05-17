import { useState } from 'react';
import { AppShell } from './components/AppShell';
import { Dashboard } from './pages/Dashboard';
import { Bookings } from './pages/Bookings';
import { Staff } from './pages/Staff';
import { Shifts } from './pages/Shifts';
import { Blog } from './pages/Blog';
import { Settings } from './pages/Settings';
import { Login } from './pages/Login';
import { AuthProvider, useAuth } from './lib/auth-context';
import type { NavKey } from './lib/nav';
import { Loader2 } from 'lucide-react';

function Routes() {
  const auth = useAuth();
  const [active, setActive] = useState<NavKey>('dashboard');

  if (auth.status === 'loading') {
    return (
      <div className="flex h-screen items-center justify-center text-ink-soft">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
        読み込み中…
      </div>
    );
  }
  if (auth.status === 'signed-out') {
    return <Login />;
  }

  return (
    <AppShell active={active} onChange={setActive}>
      {active === 'dashboard' && <Dashboard onNavigate={setActive} />}
      {active === 'bookings' && <Bookings />}
      {active === 'staff' && <Staff />}
      {active === 'shifts' && <Shifts />}
      {active === 'blog' && <Blog />}
      {active === 'settings' && <Settings />}
    </AppShell>
  );
}

export function App() {
  return (
    <AuthProvider>
      <Routes />
    </AuthProvider>
  );
}
