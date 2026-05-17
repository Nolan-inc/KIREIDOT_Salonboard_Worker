import {
  LayoutDashboard,
  CalendarRange,
  Users,
  CalendarClock,
  Newspaper,
  Settings as SettingsIcon,
  type LucideIcon,
} from 'lucide-react';

export type NavKey = 'dashboard' | 'bookings' | 'staff' | 'shifts' | 'blog' | 'settings';

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
    key: 'settings',
    label: '設定',
    description: 'サロンボード連携・各種設定',
    icon: SettingsIcon,
  },
];
