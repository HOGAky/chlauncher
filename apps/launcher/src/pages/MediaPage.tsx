/**
 * @file MediaPage.tsx
 * Media library (parity spec §4.1): import alert sounds/videos/images,
 * preview them, rename, delete (blocked while rules reference a file).
 * Files are served to overlays at /media/<id> on the overlay server.
 */
import React, { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Film, Image as ImageIcon, Music, Play, Plus, Trash2 } from 'lucide-react';
import * as api from '../api';
import { useApp } from '../App';
import type { MediaItem } from '../types';
import { Button } from '../components/ui/button';
import { Card, CardContent } from '../components/ui/card';
import { Badge } from '../components/ui/badge';
import { humanError } from '../errorMessages';

const KIND_ICON: Record<string, React.ReactNode> = {
  video: <Film size={14} />,
  gif: <Film size={14} />,
  image: <ImageIcon size={14} />,
  audio: <Music size={14} />,
};

function fmtSize(bytes: number) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
  return `${Math.max(1, Math.round(bytes / 1024))} КБ`;
}

export default function MediaPage() {
  const { boot } = useApp();
  const [items, setItems] = useState<MediaItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Overlay base for previews: http://127.0.0.1:<port>/media/<id>?t=<token>
  const mediaUrl = (id: string) => {
    const main = boot?.overlay_pages?.main;
    if (!main) return '';
    const u = new URL(main);
    return `${u.origin}/media/${id}?t=${u.searchParams.get('t')}`;
  };

  const reload = () =>
    api
      .mediaList()
      .then(setItems)
      .catch((e) => setError(humanError(e)));

  useEffect(() => {
    void reload();
  }, []);

  const used = items.reduce((a, m) => a + (m.size || 0), 0);

  const importFile = async () => {
    setError(null);
    const picked = await open({
      multiple: false,
      filters: [
        {
          name: 'Медиа (mp4, webm, gif, png, webp, jpg, mp3, ogg, wav)',
          extensions: ['mp4', 'webm', 'gif', 'png', 'webp', 'jpg', 'jpeg', 'mp3', 'ogg', 'wav'],
        },
      ],
    });
    if (!picked || Array.isArray(picked)) return;
    setBusy(true);
    try {
      await api.mediaImport(picked);
      await reload();
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (m: MediaItem) => {
    if (!window.confirm(`Удалить «${m.name}»?`)) return;
    setError(null);
    try {
      await api.mediaDelete(m.id);
      await reload();
    } catch (e) {
      setError(humanError(e));
    }
  };

  const rename = async (m: MediaItem) => {
    const name = window.prompt('Новое имя:', m.name)?.trim();
    if (!name || name === m.name) return;
    try {
      await api.mediaRename(m.id, name);
      await reload();
    } catch (e) {
      setError(humanError(e));
    }
  };

  return (
    <div className="max-w-3xl flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-lg font-semibold">Медиатека</h1>
        <Button size="sm" onClick={importFile} disabled={busy}>
          <Plus size={14} /> {busy ? 'Импорт…' : 'Добавить файл'}
        </Button>
      </div>
      <p className="text-xs text-muted-foreground">
        Файлы для алертов: звуки, видео и картинки (≤ 50 МБ, видео ≤ 30 с). Выбираются в
        drawer алерта у правила маппера. Занято: {fmtSize(used)} / 2 ГБ.
      </p>
      {error && <div className="text-xs text-red-400 whitespace-pre-wrap">{error}</div>}

      <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
        {items.map((m) => (
          <Card key={m.id} className="overflow-hidden">
            <div className="h-28 bg-secondary/40 flex items-center justify-center">
              {m.kind === 'image' || m.kind === 'gif' ? (
                <img src={mediaUrl(m.id)} alt={m.name} className="h-full object-contain" />
              ) : m.kind === 'video' ? (
                <video src={mediaUrl(m.id)} className="h-full object-contain" muted loop
                       onMouseEnter={(e) => e.currentTarget.play()}
                       onMouseLeave={(e) => e.currentTarget.pause()} />
              ) : (
                <audio src={mediaUrl(m.id)} controls className="w-full px-2" />
              )}
            </div>
            <CardContent className="p-2.5 flex flex-col gap-1">
              <button
                className="text-xs font-medium text-left truncate hover:text-primary"
                title="Переименовать"
                onClick={() => rename(m)}
              >
                {m.name}
              </button>
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                {KIND_ICON[m.kind]}
                <span>{m.ext.toUpperCase()}</span>
                <span>{fmtSize(m.size || 0)}</span>
                {m.duration_ms != null && <span>{Math.round(m.duration_ms / 1000)} с</span>}
                <Badge variant="outline" className="ml-auto text-[9px] px-1">
                  {m.kind}
                </Badge>
              </div>
              <div className="flex items-center gap-1 mt-1">
                {m.kind === 'audio' && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 text-emerald-400 hover:text-emerald-300"
                    title="Саундборд — проиграть в оверлей на стрим"
                    onClick={() => api.soundboardPlay(m.id).catch((e) => setError(humanError(e)))}
                  >
                    <Play size={12} /> на стрим
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 text-red-400 hover:text-red-300"
                  onClick={() => remove(m)}
                >
                  <Trash2 size={12} /> удалить
                </Button>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
      {items.length === 0 && (
        <p className="text-sm text-muted-foreground">
          Пусто — добавьте файл, затем выберите его в drawer алерта (🔔) у правила маппера.
        </p>
      )}
    </div>
  );
}
