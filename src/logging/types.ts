export interface LogSettings {
  enabled: boolean;
  messageChannelId: string; // deleted + edited messages
  memberChannelId: string; // joins + leaves ("" = use the message log channel)
  events: { delete: boolean; edit: boolean; join: boolean; leave: boolean };
  ignoreBots: boolean;
  ignoredChannelIds: string[]; // channels or categories that are never logged
  newAccountDays: number; // flag joins younger than this (0 = off)
}

export function defaultLogSettings(): LogSettings {
  return {
    enabled: false,
    messageChannelId: "",
    memberChannelId: "",
    events: { delete: true, edit: true, join: true, leave: true },
    ignoreBots: true,
    ignoredChannelIds: [],
    newAccountDays: 7,
  };
}
