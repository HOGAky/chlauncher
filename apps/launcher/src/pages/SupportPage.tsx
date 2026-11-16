/**
 * @file SupportPage.tsx
 * In-launcher support messenger (EFIR "EFIR CARE" parity): ticket list
 * on the left, chat thread on the right, new-ticket composer.
 * Server: /api/support/* (v12) — 5 tickets/day, 60 messages/thread.
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { CheckCircle2, CircleDot, MessageSquarePlus, Send } from 'lucide-react';
import * as api from '../api';
import { humanError } from '../errorMessages';
import type { SupportMessage, SupportTicket } from '../api';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import { Badge } from '../components/ui/badge';

const STATUS: Record<SupportTicket['status'], { label: string; cls: string }> = {
  open: { label: 'Открыт', cls: 'bg-amber-500/15 text-amber-400' },
  answered: { label: 'Есть ответ', cls: 'bg-emerald-500/15 text-emerald-400' },
  closed: { label: 'Закрыт', cls: 'bg-zinc-500/15 text-zinc-400' },
};

export default function SupportPage() {
  const [tickets, setTickets] = useState<SupportTicket[]>([]);
  const [active, setActive] = useState<number | null>(null);
  const [messages, setMessages] = useState<SupportMessage[]>([]);
  const [ticket, setTicket] = useState<SupportTicket | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [reply, setReply] = useState('');
  const [compose, setCompose] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await api.supportTickets();
      setTickets(r.tickets);
    } catch (e) {
      setError(humanError(e));
    }
  }, []);

  const openTicket = useCallback(async (id: number) => {
    setActive(id);
    setCompose(false);
    try {
      const r = await api.supportTicket(id);
      setTicket(r.ticket);
      setMessages(r.messages);
    } catch (e) {
      setError(humanError(e));
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(() => {
      load();
      if (active) openTicket(active);
    }, 10000);
    return () => clearInterval(t);
  }, [load, openTicket, active]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const create = async () => {
    if (!subject.trim() || !body.trim()) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.supportTicketCreate(subject.trim(), body.trim());
      setSubject('');
      setBody('');
      setCompose(false);
      await load();
      openTicket(r.id);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const sendReply = async () => {
    if (!reply.trim() || !active) return;
    setBusy(true);
    try {
      await api.supportReply(active, reply.trim());
      setReply('');
      openTicket(active);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const close = async () => {
    if (!active) return;
    try {
      await api.supportClose(active);
      openTicket(active);
      load();
    } catch (e) {
      setError(humanError(e));
    }
  };

  return (
    <div className="flex h-full gap-4 p-4">
      {/* ticket list */}
      <Card className="w-72 shrink-0 flex flex-col">
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-base">Поддержка</CardTitle>
            <Button size="sm" variant="outline" onClick={() => { setCompose(true); setActive(null); }}>
              <MessageSquarePlus size={14} /> Новое
            </Button>
          </div>
        </CardHeader>
        <CardContent className="flex-1 overflow-y-auto space-y-2 p-3">
          {tickets.length === 0 && (
            <p className="text-sm text-muted-foreground">
              Обращений пока нет. Опишите проблему — команда ответит здесь же.
            </p>
          )}
          {tickets.map((t) => (
            <button
              key={t.id}
              onClick={() => openTicket(t.id)}
              className={`w-full rounded-lg border p-2 text-left transition ${
                active === t.id ? 'border-primary bg-primary/10' : 'border-border hover:bg-muted/50'
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-sm font-medium">#{t.id} {t.subject}</span>
                <Badge className={STATUS[t.status].cls}>{STATUS[t.status].label}</Badge>
              </div>
              {t.last_message && (
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {t.last_message.is_admin ? 'Поддержка: ' : ''}{t.last_message.body}
                </p>
              )}
            </button>
          ))}
        </CardContent>
      </Card>

      {/* thread / composer */}
      <Card className="flex-1 flex flex-col">
        {error && <div className="mx-4 mt-3 rounded bg-destructive/15 p-2 text-sm text-destructive">{error}</div>}
        {compose ? (
          <>
            <CardHeader><CardTitle className="text-base">Новое обращение</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <Input
                placeholder="Тема — например «Не запускается игра»"
                value={subject}
                maxLength={120}
                onChange={(e) => setSubject(e.target.value)}
              />
              <textarea
                className="min-h-40 w-full rounded-md border border-input bg-background p-3 text-sm"
                placeholder="Опишите проблему подробно: что делали, что произошло, текст ошибки."
                value={body}
                maxLength={4000}
                onChange={(e) => setBody(e.target.value)}
              />
              <Button onClick={create} disabled={busy || !subject.trim() || !body.trim()}>
                <Send size={14} /> Отправить
              </Button>
            </CardContent>
          </>
        ) : ticket ? (
          <>
            <CardHeader className="pb-2">
              <div className="flex items-center justify-between">
                <CardTitle className="text-base">#{ticket.id} {ticket.subject}</CardTitle>
                {ticket.status !== 'closed' && (
                  <Button size="sm" variant="ghost" onClick={close}>
                    <CheckCircle2 size={14} /> Закрыть обращение
                  </Button>
                )}
              </div>
            </CardHeader>
            <CardContent className="flex flex-1 flex-col overflow-hidden p-3">
              <div className="flex-1 space-y-2 overflow-y-auto pr-1">
                {messages.map((m) => (
                  <div
                    key={m.id}
                    className={`max-w-[75%] rounded-lg p-2.5 text-sm ${
                      m.is_admin
                        ? 'bg-primary/15 border border-primary/25'
                        : 'ml-auto bg-muted'
                    }`}
                  >
                    <div className="mb-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                      {m.is_admin ? <CircleDot size={10} className="text-primary" /> : null}
                      {m.is_admin ? 'Поддержка' : 'Вы'} · {new Date(m.created_at).toLocaleString('ru-RU')}
                    </div>
                    {m.body}
                  </div>
                ))}
                <div ref={bottomRef} />
              </div>
              {ticket.status === 'closed' ? (
                <p className="pt-3 text-center text-sm text-muted-foreground">
                  Обращение закрыто — создайте новое при необходимости.
                </p>
              ) : (
                <div className="flex gap-2 pt-3">
                  <Input
                    placeholder="Сообщение…"
                    value={reply}
                    maxLength={4000}
                    onChange={(e) => setReply(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && sendReply()}
                  />
                  <Button onClick={sendReply} disabled={busy || !reply.trim()}>
                    <Send size={14} />
                  </Button>
                </div>
              )}
            </CardContent>
          </>
        ) : (
          <CardContent className="flex flex-1 items-center justify-center text-muted-foreground">
            <p className="text-sm">Выберите обращение слева или создайте новое.</p>
          </CardContent>
        )}
      </Card>
    </div>
  );
}
