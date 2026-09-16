export interface UpdateCheckSchedule {
  day: string;
  dueAt: number;
  checked: boolean;
}

export type UpdateNoticeStatus = "announcing" | "countdown" | "cancelled" | "preparing" | "scheduled" | "completed" | "failed";

export interface UpdateNotice {
  version: string;
  currentVersion: string;
  userOpenId: string;
  token: string;
  notes: string;
  status: UpdateNoticeStatus;
  messageId?: string;
  deadline?: number;
  error?: string;
}
