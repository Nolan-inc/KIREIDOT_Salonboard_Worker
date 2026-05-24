import {
  LayoutDashboard,
  CalendarRange,
  Users,
  CalendarClock,
  Newspaper,
  Link2,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export type NavKey =
  | 'dashboard'
  | 'bookings'
  | 'staff'
  | 'shifts'
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
    key: 'shifts',
    label: 'シフト',
    description: 'シフトの確認・登録',
    icon: CalendarClock,
  },
  {
    key: 'blog',
    label: 'ブログ',
    description: 'ブログ記事の作成・投稿',
    icon: Newspaper,
  },
  {
    key: 'salonboard',
    label: 'サロンボード連携',
    description: '会社×店舗ごとの認証情報を管理・同期',
    icon: Link2,
  },
  {
    key: 'settings',
    label: '設定',
    description: 'アカウント・各種設定',
    icon: SettingsIcon,
  },
];
