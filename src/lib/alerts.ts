import "server-only";
import type { Org } from "./tenant-db.ts";
import type { SessionUser } from "./permissions.ts";
import { can } from "./permissions.ts";
import { needsAttention, attentionTotal, type AttentionRule } from "./attention.ts";
import { pressingTasks, taskCounts, type TaskRow } from "./tasks.ts";
import { unreadCount } from "./announcements.ts";
import { unreadMessages } from "./communication.ts";
import type { Tone } from "./constants.ts";

/**
 * Alerts — deliberately **not** a table.
 *
 * Every alert is a live query against the thing it is about, so it clears the moment that
 * thing is resolved. A stored notification would have to be marked read, expired, and
 * garbage-collected, and would still be able to disagree with reality — a "carrier's
 * insurance has lapsed" row surviving after the certificate was renewed is worse than no
 * alert at all. `attention.ts` already worked this way; this composes it with tasks and
 * the noticeboard rather than inventing a second mechanism beside it.
 *
 * What a person sees is scoped by what they may already see: the carrier rules only for
 * someone with `carrier:view`, everybody's tasks only for someone who may assign them.
 */

export type AlertGroup = {
  key: string;
  label: string;
  description: string;
  tone: Tone;
  count: number;
  href: string;
};

export type Alerts = {
  total: number;
  /** The carrier work queue, unchanged — empty for a role that cannot see carriers. */
  attention: AttentionRule[];
  overdueTasks: TaskRow[];
  tasks: { open: number; overdue: number; dueToday: number };
  unreadAnnouncements: number;
  unreadMessages: number;
  /** The headline strip: one row per kind of thing wanting attention. */
  groups: AlertGroup[];
};

export function alertsFor(org: Org, user: SessionUser): Alerts {
  // Whoever may put work on other people's lists is looking at the whole board; everyone
  // else is looking at their own. Same test as /tasks, because two rules would drift.
  const scope = can(user, "task:assign") ? undefined : user.id;

  const attention = can(user, "carrier:view") ? needsAttention(org) : [];
  const tasks = taskCounts(org, scope);
  const overdueTasks = pressingTasks(org, scope);
  const unreadAnnouncements = can(user, "announcement:view") ? unreadCount(org, user.id) : 0;
  // Already narrowed to the channels this person may read — see communication.ts.
  const messages = can(user, "message:view") ? unreadMessages(org, user) : 0;

  const groups: AlertGroup[] = [];
  if (tasks.overdue > 0) {
    groups.push({
      key: "tasks_overdue",
      label: "Overdue tasks",
      description: scope === undefined ? "Past their due date, across the team" : "Past their due date",
      tone: "red",
      count: tasks.overdue,
      href: "/tasks",
    });
  }
  if (tasks.dueToday > 0) {
    groups.push({
      key: "tasks_today",
      label: "Due today",
      description: "Tasks with today's date on them",
      tone: "amber",
      count: tasks.dueToday,
      href: "/tasks",
    });
  }
  if (messages > 0) {
    groups.push({
      key: "messages",
      label: "Unread messages",
      description: "In the channels you are part of",
      tone: "purple",
      count: messages,
      href: "/communication",
    });
  }
  if (unreadAnnouncements > 0) {
    groups.push({
      key: "announcements",
      label: "Unread announcements",
      description: "Published since you last opened the noticeboard",
      tone: "blue",
      count: unreadAnnouncements,
      href: "/announcements",
    });
  }
  for (const rule of attention) {
    groups.push({
      key: rule.key,
      label: rule.label,
      description: rule.description,
      tone: rule.tone,
      count: rule.count,
      href: rule.href ?? "/alerts",
    });
  }

  return {
    total:
      tasks.overdue + tasks.dueToday + unreadAnnouncements + messages + attentionTotal(attention),
    attention,
    overdueTasks,
    tasks,
    unreadAnnouncements,
    unreadMessages: messages,
    groups,
  };
}
