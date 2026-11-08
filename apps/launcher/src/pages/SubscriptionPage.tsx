/**
 * @file SubscriptionPage.tsx
 * Subscription dashboard: status, expiry date, days remaining,
 * mock payment / mock expiry buttons for testing the billing loop.
 */
import React, { useState } from 'react';
import { CreditCard, ShieldAlert, FlaskConical } from 'lucide-react';
import * as api from '../api';
import { useApp } from '../App';
import { Button } from '../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

import { humanError } from '../errorMessages';
export default function SubscriptionPage() {
  const { subscription, refreshSubscription } = useApp();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = subscription?.status === 'active';

  /** Runs a billing action then refreshes local state. */
  const act = (fn: () => Promise<unknown>) => async () => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      await refreshSubscription();
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
    <div className="max-w-xl flex flex-col gap-4">
      <h1 className="text-lg font-semibold">Подписка</h1>
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2">
              <CreditCard size={18} /> Месячная подписка
            </CardTitle>
            <Badge variant={active ? 'success' : 'destructive'}>
              {active ? 'Активна' : subscription?.status === 'canceled' ? 'Отменена' : 'Истекла'}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {active && endDate ? (
            <p className="text-sm">
              Активна до <b>{endDate.toLocaleDateString('ru-RU')}</b> — осталось{' '}
              <b>{subscription!.days_left}</b> дн.
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              Подписка не активна — запуск игр заблокирован. Оплатите, чтобы получить
              доступ на 30 дней.
            </p>
          )}
          {error && (
            <div className="text-xs text-red-400 bg-destructive/10 border border-destructive/30 rounded-md px-3 py-2">
              {error}
            </div>
          )}
          <div className="flex flex-wrap gap-2 pt-1">
            <Button disabled={busy} onClick={act(() => api.checkout())}>
              <CreditCard size={14} /> Оплатить на 1 месяц
            </Button>
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
                  title="Тест: mock-pay (только dev)"
                  onClick={act(() => api.mockPay())}
                >
                  <FlaskConical size={14} /> Тест: оплатить
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
            <ShieldAlert size={12} /> Оплата откроется в браузере (ЮKassa). После
            оплаты лаунчер обновит статус автоматически или по кнопке проверки.
          </p>
        </CardContent>
      </Card>
    </div>
  );
}
