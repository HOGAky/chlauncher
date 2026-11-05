/**
 * @file SimulatorPage.tsx
 * Event simulator — manual buttons that inject fake TikTok gifts/likes/
 * comments and DonationAlerts donations into the real mapping pipeline.
 * Lets streamers test the whole setup without going live, and lets us
 * develop end-to-end without real accounts.
 */
import React, { useState } from 'react';
import { Gift, Heart, MessageSquare, Wallet, Send } from 'lucide-react';
import * as api from '../api';
import type { RawStreamEvent } from '../types';
import { Button } from '../components/ui/button';
import { Input } from '../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../components/ui/card';
import EventFeed from '../components/EventFeed';

/** Builds a raw simulator event with a random fake user. */
function raw(kind: string, rawName: string, amount: number, source = 'simulator'): RawStreamEvent {
  const users = ['anika_live', 'triggor', 'mr_donut', 'stream_fan22', 'zuzu'];
  return {
    source,
    event_kind: kind,
    user: users[Math.floor(Math.random() * users.length)],
    avatar_url: '',
    raw_name: rawName,
    amount,
  };
}

export default function SimulatorPage() {
  const [giftName, setGiftName] = useState('Rose');
  const [likeCount, setLikeCount] = useState(100);
  const [comment, setComment] = useState('привет!');
  const [donation, setDonation] = useState(100);
  const [donor, setDonor] = useState('kind_viewer');

  const send = (r: RawStreamEvent) => api.simulateEvent(r).catch((e) => console.error(e));

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
      <div className="flex flex-col gap-4">
        <h1 className="text-lg font-semibold">Симулятор событий</h1>
        <p className="text-xs text-muted-foreground">
          События проходят через тот же маппер, что и настоящие — проверяйте
          правила до выхода в эфир.
        </p>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Gift size={15} /> Подарок TikTok
            </CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input value={giftName} onChange={(e) => setGiftName(e.target.value)} placeholder="Rose" />
            <Button
              variant="secondary"
              onClick={() => send(raw('gift', giftName, 1, 'tiktok'))}
            >
              <Send size={14} /> Отправить
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Heart size={15} /> Лайки TikTok
            </CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input
              type="number"
              min={1}
              value={likeCount}
              onChange={(e) => setLikeCount(Number(e.target.value) || 0)}
            />
            <Button
              variant="secondary"
              onClick={() => send(raw('like', 'likes', likeCount, 'tiktok'))}
            >
              <Send size={14} /> ×{likeCount}
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <MessageSquare size={15} /> Комментарий
            </CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input value={comment} onChange={(e) => setComment(e.target.value)} />
            <Button
              variant="secondary"
              onClick={() => send(raw('comment', comment, 1, 'tiktok'))}
            >
              <Send size={14} />
            </Button>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2">
              <Wallet size={15} /> Донат DonationAlerts
            </CardTitle>
          </CardHeader>
          <CardContent className="flex gap-2">
            <Input value={donor} onChange={(e) => setDonor(e.target.value)} placeholder="ник" />
            <Input
              className="w-28"
              type="number"
              min={1}
              value={donation}
              onChange={(e) => setDonation(Number(e.target.value) || 0)}
            />
            <Button
              variant="accent"
              onClick={() =>
                send({
                  source: 'donationalerts',
                  event_kind: 'donation',
                  user: donor || 'donor',
                  avatar_url: '',
                  raw_name: `донат ${donation}₽`,
                  amount: donation * 100, // minor units, как в DA
                })
              }
            >
              <Send size={14} /> {donation}₽
            </Button>
          </CardContent>
        </Card>
      </div>

      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-semibold text-muted-foreground">
          Лента событий → игре / оверлею
        </h2>
        <EventFeed />
      </div>
    </div>
  );
}
