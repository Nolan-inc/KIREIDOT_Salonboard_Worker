import {
  LayoutDashboard,
  CalendarRange,
  Users,
  CalendarClock,
  Newspaper,
  BookOpen,
  Scissors,
  Ticket,
  Link2,
  Settings as SettingsIcon,
  Store,
  type LucideIcon,
} from 'lucide-react';

export type NavKey =
  | 'shops'
  | 'dashboard'
  | 'bookings'
  | 'staff'
  | 'menus'
  | 'coupons'
  | 'shifts'
  | 'styles'
  | 'blog'
  | 'salonboard'
  | 'settings';

export type NavItem = {
  key: NavKey;
  label: string;
  description: string;
  icon: LucideIcon;
};

export const NAV_ITEMS: NavItem[] = [
  {
    key: 'shops',
    label: '店舗一覧',
    description: '会社内の店舗を選んで操作します',
    icon: Store,
  },
  {
    key: 'salonboard',
    label: 'サロンボード連携',
    description: '会社×店舗ごとの認証情報を管理・同期',
    icon: Link2,
  },
  {
    key: 'dashboard',
    label: 'ダッシュボード',
    description: '今日のサロンの状況をひと目で',
    icon: LayoutDashboard,
  },
  {
    key: 'bookings',
    label: '予約',
    description: '予約の一覧・新規登録・編集',
    icon: CalendarRange,
  },
  {
    key: 'staff',
    label: 'スタッフ',
    description: 'スタッフ情報の取得・編集',
    icon: Users,
  },
  {
    key: 'menus',
    label: 'メニュー',
    description: 'SalonBoard取得・KIREIDOT登録のメニュー一覧',
    icon: BookOpen,
  },
  {
    key: 'coupons',
    label: 'クーポン',
    description: 'SalonBoard から取得したクーポン一覧',
    icon: Ticket,
  },
  {
    key: 'shifts',
    label: 'シフト',
    description: 'シフトの確認・登録',
    icon: CalendarClock,
  },
  {
    key: 'styles',
    label: 'スタイル/ギャラリー',
    description: 'SalonBoard 取得の美容室スタイル / エステ等フォトギャラリー一覧',
    icon: Scissors,
  },
  {
    key: 'blog',
    label: 'ブログ',
    description: 'ブログ記事の作成・投稿',
    icon: Newspaper,
  },
  {
    key: 'settings',
    label: '設定',
    description: 'アカウント・各種設定',
    icon: SettingsIcon,
  },
];

/** 店舗スコープを必要とするページ (= 店舗未選択時は隠す)。 */
const SHOP_SCOPED_KEYS: ReadonlySet<NavKey> = new Set<NavKey>([
  'dashboard',
  'bookings',
  'staff',
  'menus',
  'coupons',
  'shifts',
  'styles',
  'blog',
]);

/**
 * 現在の選択状態 (店舗が選ばれているか) に応じて、サイドバーに表示すべき
 * NavKey の配列を返す。
 *  - 店舗未選択: 店舗一覧 / サロンボード連携 / 設定
 *  - 店舗選択済み: 全項目
 *
 * 「店舗一覧」は常に表示 (=店舗を切り替える入口を確保する)。
 */
export function getVisibleNavKeys(hasShop: boolean): NavKey[] {
  return NAV_ITEMS.map((i) => i.key).filter((k) => {
    if (hasShop) return true;
    return !SHOP_SCOPED_KEYS.has(k);
  });
}

export function isShopScoped(key: NavKey): boolean {
  return SHOP_SCOPED_KEYS.has(key);
}
