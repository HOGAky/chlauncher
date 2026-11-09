/**
 * @file SubscriptionPage.tsx
 * Subscription dashboard + tariff comparison (§8): current plan card,
 * monthly earn-limit usage bar, plan cards with feature lists and
 * per-plan checkout. Mock billing buttons stay dev-only.
 */
import React, { useEffect, useMemo, useState } from 'react';
import { CreditCard, ShieldAlert, FlaskConical, Check, X, Infinity as Inf } from 'lucide-react';
import * as api from '../api';
import { useApp } from '../App';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import type { Plan, EntitlementsResponse } from '../types';
import { humanError } from '../errorMessages';

/** Formats kopecks → "299 ₽" (RUB only for now — plans carry `currency`). */
function fmtPrice(p: Plan): string {
  if (p.price_minor <= 0) return 'Бесплатно';
  const rub = p.price_minor / 100;
  return `${rub % 1 === 0 ? rub : rub.toFixed(2)} ₽`;
}

/** `null` means «без лимита». */
const lim = (v: number | null) =>
  v === null || v === undefined ? <Inf size={13} className="inline" /> : String(v);

/** One feature row in the plan card — icon for bools, number for caps. */
function Feature({ ok, label, value }: { ok?: boolean; label: string; value?: React.ReactNode }) {
  return (
    <li className="flex items-center gap-2 text-xs">
      {value !== undefined ? (
        <span className="text-primary font-mono w-8 text-right">{value}</span>
      ) : ok ? (
        <Check size={13} className="text-emerald-400 w-8 text-right" />
      ) : (
        <X size={13} className="text-muted-foreground/50 w-8 text-right" />
      )}
      <span className={ok === false && value === undefined ? 'text-muted-foreground/70' : ''}>
        {label}
      </span>
    </li>
  );
}

export default function SubscriptionPage() {
  const { subscription, refreshSubscription } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [plans, setPlans] = useState<Plan[]>([]);
  const [ent, setEnt] = useState<EntitlementsResponse | null>(null);
  const active = subscription?.status === 'active';
  const currentPlan = ent?.plan.code ?? (active ? subscription?.plan_code ?? 'pro' : 'free');

  useEffect(() => {
    api.getPlans().then(setPlans).catch(() => setPlans([]));
    api.getEntitlements().then(setEnt).catch(() => setEnt(null));
  }, [subscription?.status, subscription?.plan_code]);

  const earnLimit = ent?.entitlements.earn_limit_coins_month ?? null;
  const usedCoins = ent?.usage.coins ?? 0;
  const usagePct = useMemo(() => {
    if (!earnLimit || earnLimit <= 0) return 0;
    return Math.min(100, Math.round((usedCoins / earnLimit) * 100));
  }, [usedCoins, earnLimit]);

  /** Runs a billing action then refreshes local state. */
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshSubscription();
      setEnt(await api.getEntitlements().catch(() => ent));
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const endDate = subscription?.current_period_end
    ? new Date(subscription.current_period_end)
    : null;

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Подписка и тариф</h1>

      {/* current status card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <CreditCard size={18} /> Текущий план: {ent?.plan.title ?? currentPlan}
            </CardTitle>
            <Badge variant={active ? 'success' : 'destructive'}>
              {active ? 'Активна' : subscription?.status === 'canceled' ? 'Отменена' : 'Free'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {active && endDate ? (
            <p className="text-sm">
              Оплачено до <b>{endDate.toLocaleDateString('ru-RU')}</b> — осталось{' '}
              <b>{subscription!.days_left}</b> дн.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Бесплатный тариф: запуск платных игр и часть функций недоступны.
              Оплатите план, чтобы снять ограничения.
            </p>
          )}

          {/* monthly earn-limit usage bar */}
          {earnLimit !== null && (
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Монет событий за месяц ({ent?.usage.month})</span>
                <span>
                  {usedCoins.toLocaleString('ru-RU')} / {earnLimit.toLocaleString('ru-RU')}
                </span>
              </div>
              <div className="h-2 rounded bg-secondary overflow-hidden">
                <div
                  className={`h-full transition-all ${
                    usagePct >= 100 ? 'bg-red-500' : usagePct >= 80 ? 'bg-amber-500' : 'bg-primary'
                  }`}
                  style={{ width: `${Math.max(usagePct, 2)}%` }}
                />
              </div>
              {usagePct >= 100 && (
                <p className="text-xs text-red-400">
                  Лимит месяца исчерпан — платные события не запускают действия. Апгрейд снимает
                  ограничение.
                </p>
              )}
            </div>
          )}

          {error && (
            <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <div className="flex flex-wrap gap-2 pt-1">
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              title="Перепроверить статус после оплаты в браузере"
              onClick={act(() => refreshSubscription())}
            >
              Я оплатил — проверить
            </Button>
            {import.meta.env.DEV && (
              <>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title="Тест: mock-pay pro (только dev)"
                  onClick={act(() => api.mockPay('pro'))}
                >
                  <FlaskConical size={14} /> Тест: pro
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title="Тест: mock-pay expert (только dev)"
                  onClick={act(() => api.mockPay('expert'))}
                >
                  <FlaskConical size={14} /> Тест: expert
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  title="Тест: принудительно завершает подписку"
                  onClick={act(() => api.mockExpire())}
                >
                  <FlaskConical size={14} /> Тест: истечь
                </Button>
              </>
            )}
          </div>
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <ShieldAlert size={12} /> Оплата откроется в браузере (ЮKassa). Смена плана при активной
            подписке добавляет период нового плана к текущей дате — остаток дней старого плана не
            пересчитывается.
          </p>
        </CardContent>
      </Card>

      {/* plan comparison cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        {plans.map((p) => {
          const e = p.entitlements;
          const isCurrent = p.code === currentPlan;
          return (
            <Card
              key={p.code}
              className={isCurrent ? 'border-primary ring-1 ring-primary/40' : ''}
            >
              <CardHeader className="pb-2">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">{p.title}</CardTitle>
                  {isCurrent && <Badge variant="success">текущий</Badge>}
                </div>
                <div className="text-xl font-bold">
                  {fmtPrice(p)}
                  {p.price_minor > 0 && (
                    <span className="text-xs font-normal text-muted-foreground">
                      {' '}
                      / {p.period_days} дн
                    </span>
                  )}
                </div>
              </CardHeader>
              <CardContent className="flex flex-col gap-3">
                <ul className="flex flex-col gap-1.5">
                  <Feature label="пресетов" value={lim(e.max_presets)} />
                  <Feature label="правил в пресете" value={lim(e.max_rules_per_preset)} />
                  <Feature label="медиа-триггеров" value={lim(e.max_media_triggers)} />
                  <Feature ok={e.tts} label="TTS (озвучка)" />
                  <Feature ok={e.spinner} label="Колесо подарков" />
                  <Feature ok={e.custom_overlay_style} label="Стили оверлея" />
                  <Feature ok={e.interrupts} label="Прерывания-алерты" />
                  <Feature ok={e.paid_games} label="Платные игры" />
                  <Feature
                    label="монет событий/мес"
                    value={lim(e.earn_limit_coins_month)}
                  />
                </ul>
                {p.price_minor > 0 &&
                  (isCurrent ? (
                    <Button size="sm" variant="outline" disabled={busy} onClick={act(() => api.checkout(p.code))}>
                      Продлить {p.title}
                    </Button>
                  ) : (
                    <Button size="sm" disabled={busy} onClick={act(() => api.checkout(p.code))}>
                      <CreditCard size={14} /> Выбрать {p.title}
                    </Button>
                  ))}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
