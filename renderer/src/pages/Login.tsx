import { useState } from 'react';
import { Mail, Lock, Loader2 } from 'lucide-react';
import { useAuth } from '../lib/auth-context';

export function Login() {
  const { signIn, signInWithGoogle } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const { error } = await signIn(email.trim(), password);
    setLoading(false);
    if (error) setError(error);
  }

  async function onGoogleClick() {
    setError(null);
    setGoogleLoading(true);
    const { error } = await signInWithGoogle();
    // ボタン押下後は外部ブラウザに遷移するため、ローディングは
    // すぐに解除して「ブラウザで続行してください」状態に戻す。
    setGoogleLoading(false);
    if (error) setError(error);
  }

  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 bg-desk-aurora opacity-70" />
      <div
        aria-hidden
        className="pointer-events-none absolute -left-24 top-32 -z-10 hidden h-72 w-72 rounded-full bg-brand-200/50 blur-3xl md:block"
      />
      <div
        aria-hidden
        className="pointer-events-none absolute -right-32 bottom-10 -z-10 hidden h-96 w-96 rounded-full bg-brand-300/40 blur-3xl md:block"
      />

      <div className="app-drag absolute inset-x-0 top-0 h-10" />

      <div className="glass-card mx-4 w-full max-w-[420px] rounded-hero px-8 py-10 shadow-card">
        <div className="mb-8 flex flex-col items-center text-center">
          <div className="flex h-12 w-12 items-center justify-center rounded-[12px] bg-brand-gradient text-white shadow-brand-sm">
            <span className="font-serif text-[20px] font-bold">K</span>
          </div>
          <span className="mt-4 inline-flex items-center rounded-full bg-brand-light px-3 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-brand-700">
            Salon Desk
          </span>
          <h1 className="mt-3 font-serif text-[26px] font-bold leading-tight text-ink">
            KIREIDOT サロンデスク
          </h1>
          <p className="mt-1 text-[12px] text-ink-soft">
            スタッフアカウントでログインしてください
          </p>
        </div>

        <button
          type="button"
          onClick={onGoogleClick}
          disabled={googleLoading || loading}
          className="mb-4 inline-flex h-11 w-full items-center justify-center gap-2.5 rounded-[12px] border border-hairline bg-white text-[13.5px] font-semibold text-ink shadow-sm transition hover:bg-slate-50 disabled:opacity-60"
        >
          {googleLoading ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              ブラウザを開いています…
            </>
          ) : (
            <>
              <GoogleIcon />
              Google でログイン
            </>
          )}
        </button>

        <div className="mb-4 flex items-center gap-3">
          <div className="h-px flex-1 bg-hairline" />
          <span className="text-[10px] font-bold uppercase tracking-[0.18em] text-muted-faint">
            または
          </span>
          <div className="h-px flex-1 bg-hairline" />
        </div>

        <form onSubmit={onSubmit} className="flex flex-col gap-3">
          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.18em] text-ink-soft">
              メールアドレス
            </span>
            <div className="relative">
              <Mail className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-faint" size={14} />
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                placeholder="you@salon.example"
                className="h-11 w-full rounded-[12px] border border-hairline bg-white/85 pl-9 pr-3 text-[14px] text-ink placeholder:text-muted-faint focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20"
              />
            </div>
          </label>

          <label className="block">
            <span className="mb-1 block text-[10px] font-bold uppercase tracking-[0.18em] text-ink-soft">
              パスワード
            </span>
            <div className="relative">
              <Lock className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-faint" size={14} />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
                required
                placeholder="••••••••"
                className="h-11 w-full rounded-[12px] border border-hairline bg-white/85 pl-9 pr-3 text-[14px] text-ink placeholder:text-muted-faint focus:border-brand-300 focus:outline-none focus:ring-2 focus:ring-brand/20"
              />
            </div>
          </label>

          {error && (
            <div className="rounded-[10px] border border-red-200 bg-red-50 px-3 py-2 text-[12px] text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={loading}
            className="mt-2 inline-flex h-11 items-center justify-center gap-2 rounded-[12px] bg-brand-gradient text-[14px] font-semibold text-white shadow-brand-sm transition hover:shadow-brand disabled:opacity-60"
          >
            {loading ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" /> ログイン中…
              </>
            ) : (
              'ログイン'
            )}
          </button>
        </form>

        <p className="mt-6 text-center text-[10px] text-muted">
          KIREIDOT スタッフ専用 ・ 一般のお客様は KIREIDOT アプリをご利用ください
        </p>
      </div>
    </div>
  );
}

/** Google 公式 G ロゴ (SVG, 18×18) */
function GoogleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M17.64 9.205c0-.639-.057-1.252-.164-1.841H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.259h2.908c1.702-1.567 2.684-3.875 2.684-6.615Z"
      />
      <path
        fill="#34A853"
        d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.583-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18Z"
      />
      <path
        fill="#FBBC05"
        d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.997 8.997 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332Z"
      />
      <path
        fill="#EA4335"
        d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58Z"
      />
    </svg>
  );
}
