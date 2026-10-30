/**
 * Discord doesn't tell us what a deleted message said, so we remember recent messages ourselves.
 * This lives in memory only: nothing is written to disk, and a restart forgets it.
 */
export interface CachedMessage {
  id: string;
  guildId: string;
  channelId: string;
  authorId: string;
  authorTag: string;
  authorAvatar: string;
  content: string;
  attachments: { name: string; url: string }[];
  createdAt: number;
}

export class MessageCache {
  private map = new Map<string, CachedMessage>();

  constructor(private max: number) {}

  get size() {
    return this.map.size;
  }

  get(id: string) {
    return this.map.get(id);
  }

  set(message: CachedMessage) {
    this.map.delete(message.id); // re-insert so it counts as the newest
    this.map.set(message.id, message);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value as string);
  }

  delete(id: string) {
    this.map.delete(id);
  }
}

export const messageCache = new MessageCache(Number(process.env.LOG_CACHE_SIZE) || 10_000);
