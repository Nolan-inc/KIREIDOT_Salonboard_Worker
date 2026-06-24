import { useEffect, useState } from 'react';
import { AppShell } from './components/AppShell';
import { UpdaterToast } from './components/UpdaterToast';
import { Dashboard } from './pages/Dashboard';
import { Bookings } from './pages/Bookings';
import { Staff } from './pages/Staff';
import { Menus } from './pages/Menus';
import { Coupons } from './pages/Coupons';
import { Shifts } from './pages/Shifts';
import { Equipment } from './pages/Equipment';
import { Styles } from './pages/Styles';
import { Blog } from './pages/Blog';
import { Reviews } from './pages/Reviews';
import { Settings } from './pages/Settings';
import { SalonboardPage } from './pages/Salonboard';
import { ShopList } from './pages/ShopList';
import { Login } from './pages/Login';
import { AuthProvider, useAuth } from './lib/auth-context';
import { SelectionProvider, useSelection } from './lib/selection-context';
import { SyncControllerProvider } from './lib/sync-controller';
import { isShopScoped, type NavKey } from './lib/nav';
import { Loader2 } from 'lucide-react';

function Routes() {
  const auth = useAuth();
  const { selectedShopId } = useSelection();
  const [active, setActive] = useState<NavKey>('shops');

  // 店舗未選択でショップスコープのページに居る場合は強制的に店舗一覧へ戻す。
  // 店舗の選択解除 (Sidebar の x ボタン) でもこのガードが効く。
  useEffect(() => {
    if (!selectedShopId && isShopScoped(active)) {
      setActive('shops');
    }
  }, [selectedShopId, active]);

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
      {active === 'shops' && <ShopList onPickShop={setActive} />}
      {active === 'dashboard' && selectedShopId && <Dashboard onNavigate={setActive} />}
      {active === 'bookings' && selectedShopId && <Bookings />}
      {active === 'staff' && selectedShopId && <Staff />}
      {active === 'menus' && selectedShopId && <Menus />}
      {active === 'coupons' && selectedShopId && <Coupons />}
      {active === 'shifts' && selectedShopId && <Shifts />}
      {active === 'equipment' && selectedShopId && <Equipment />}
      {active === 'styles' && selectedShopId && <Styles />}
      {active === 'blog' && selectedShopId && <Blog />}
      {active === 'reviews' && selectedShopId && <Reviews />}
      {active === 'salonboard' && <SalonboardPage />}
      {active === 'settings' && <Settings />}
    </AppShell>
  );
}

export function App() {
  return (
    <AuthProvider>
      <SelectionProvider>
        <SyncControllerProvider>
          <Routes />
          {/* 自動アップデート完了の通知トースト (Electron 起動時のみ動作) */}
          <UpdaterToast />
        </SyncControllerProvider>
      </SelectionProvider>
    </AuthProvider>
  );
}
