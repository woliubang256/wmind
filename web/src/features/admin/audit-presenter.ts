import type { TFunction } from 'i18next';
import type { IconName } from '@/components/ui/icon';
import type { AuditLog } from '@/lib/api/types';
import { formatDateTime, formatList } from '@/lib/format';
import { findField } from './settings-schema';

export const AUDIT_ACTIONS = [
  { value: 'user.create', labelKey: 'admin.audit.createUser' },
  { value: 'user.update', labelKey: 'admin.audit.updateUser' },
  { value: 'user.disable', labelKey: 'admin.audit.disableUser' },
  { value: 'user.enable', labelKey: 'admin.audit.enableUser' },
  { value: 'user.delete', labelKey: 'admin.audit.deleteUser' },
  { value: 'user.role', labelKey: 'admin.audit.changeRole' },
  { value: 'user.reset_password', labelKey: 'admin.audit.resetPassword' },
  { value: 'settings.update', labelKey: 'admin.audit.updateSettings' },
  { value: 'share.create', labelKey: 'admin.audit.createShare' },
  { value: 'share.revoke', labelKey: 'admin.audit.revokeShare' },
] as const;

export interface AuditDetail { label: string; value: string }
export interface AuditPresentation {
  action: string;
  summary: string;
  icon: IconName;
  tone: 'neutral' | 'warning' | 'danger';
  details: AuditDetail[];
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
function text(value: unknown): string { return typeof value === 'string' ? value.trim() : ''; }
function ownKey(table: Record<string, string>, key: string): string | undefined {
  return Object.hasOwn(table, key) ? table[key] : undefined;
}

const AI_FIELDS: Record<string, string> = {
  'ai.config': 'admin.audit.aiConfiguration',
  'ai.enabled': 'ai.enabled',
  'ai.baseUrl': 'admin.audit.aiProviderAddress',
  'ai.apiKey': 'admin.audit.aiProviderKey',
  'ai.model': 'admin.audit.aiModel',
  'ai.reasoningEffort': 'ai.reasoningEffort',
};

/** Unknown detail is never stringified; only explicitly supported event fields are displayed. */
export function presentAuditLog(log: AuditLog, t: TFunction): AuditPresentation {
  const detail = record(log.detail);
  const actor = record(log.actor ?? detail.actor);
  const nickname = text(actor.nickname);
  const username = text(actor.username);
  const actorName = nickname && username && nickname !== username
    ? t('admin.audit.namedUser', { nickname, username })
    : nickname || username || t('admin.audit.unknownActor');
  const isShare = log.action === 'share.create' || log.action === 'share.revoke';
  const isUser = log.action.startsWith('user.');
  const target = text(log.targetName) || text(detail.targetName)
    || (isShare ? text(detail.mapTitle) : isUser ? text(detail.username) || text(detail.nickname) : '')
    || t(isShare ? 'admin.audit.unknownMap' : isUser ? 'admin.audit.unknownUser' : 'admin.audit.unknownTarget');
  const action = AUDIT_ACTIONS.find((item) => item.value === log.action);
  const result: AuditPresentation = {
    action: action ? t(action.labelKey) : t('admin.audit.otherAction'),
    summary: '', icon: isShare ? 'link' : isUser ? 'user' : log.action === 'settings.update' ? 'settings' : 'clock',
    tone: log.action === 'user.delete' || log.action === 'share.revoke' ? 'danger'
      : log.action === 'user.disable' || log.action === 'user.reset_password' || log.action === 'user.role' ? 'warning' : 'neutral',
    details: [],
  };
  const add = (labelKey: string, value: string) => { if (value) result.details.push({ label: t(labelKey), value }); };
  const role = (value: unknown) => value === 'user' ? t('admin.users.roleUser') : value === 'admin' ? t('admin.users.roleAdmin') : '';
  const status = (value: unknown) => value === 'active' ? t('admin.users.statusActive')
    : value === 'disabled' ? t('admin.users.statusDisabled') : value === 'pending' ? t('admin.users.statusPending') : '';

  const summaries: Record<string, string> = {
    'user.create': 'admin.audit.summaryCreateUser',
    'user.update': 'admin.audit.summaryUpdateUser',
    'user.disable': 'admin.audit.summaryDisableUser',
    'user.enable': 'admin.audit.summaryEnableUser',
    'user.delete': 'admin.audit.summaryDeleteUser',
    'user.reset_password': 'admin.audit.summaryResetPassword',
    'user.role': 'admin.audit.summaryChangeRole',
    'share.create': 'admin.audit.summaryCreateShare',
    'share.revoke': 'admin.audit.summaryRevokeShare',
  };
  if (log.action === 'settings.update') {
    const keys = Array.isArray(detail.keys) ? detail.keys.filter((key): key is string => typeof key === 'string') : Object.keys(record(detail.changes));
    const fields = [...new Set(keys.map((key) => {
      const labelKey = findField(key)?.labelKey ?? ownKey(AI_FIELDS, key);
      return t(labelKey ?? 'admin.audit.otherSetting');
    }))];
    const fieldsText = fields.length ? formatList(fields) : t('admin.audit.systemSettings');
    result.summary = t('admin.audit.summarySettings', { actor: actorName, fields: fieldsText });
    add('admin.audit.changedFields', fieldsText);
  } else if (log.action === 'user.role' && role(detail.from) && role(detail.to)) {
    result.summary = t('admin.audit.summaryRoleChange', { actor: actorName, target, from: role(detail.from), to: role(detail.to) });
  } else {
    result.summary = t(ownKey(summaries, log.action) ?? 'admin.audit.summaryOther', { actor: actorName, target });
  }

  if (isShare) {
    for (const [key, labelKey] of [
      ['hasPassword', 'admin.audit.accessPassword'], ['allowDownload', 'admin.audit.downloadPermission'], ['showNotes', 'admin.audit.topicNotes'],
    ] as const) {
      if (typeof detail[key] === 'boolean') add(labelKey, t(key === 'hasPassword'
        ? detail[key] ? 'admin.audit.enabled' : 'admin.audit.disabled'
        : detail[key] ? 'admin.audit.allowed' : 'admin.audit.disallowed'));
    }
    if (detail.expiresAt === null) add('admin.audit.expiresAt', t('admin.audit.neverExpires'));
    else if (typeof detail.expiresAt === 'string' && Number.isFinite(new Date(detail.expiresAt).getTime())) add('admin.audit.expiresAt', formatDateTime(detail.expiresAt));
    add('admin.audit.mapId', text(detail.mapUid));
  }
  if (log.action === 'user.role' || log.action === 'user.disable' || log.action === 'user.enable') {
    const from = log.action === 'user.role' ? role(detail.from) : status(detail.from);
    const to = log.action === 'user.role' ? role(detail.to) : status(detail.to);
    add('admin.audit.previousValue', from);
    add('admin.audit.newValue', to);
  }
  if (log.action === 'user.create') add('admin.audit.userRole', role(detail.role));
  if (log.action === 'user.update') {
    add('admin.audit.nickname', text(detail.nickname));
    add('admin.audit.email', text(detail.email));
  }
  if (log.action === 'user.reset_password' && typeof detail.generated === 'boolean') {
    add('admin.audit.passwordMethod', t(detail.generated ? 'admin.audit.randomPassword' : 'admin.audit.specifiedPassword'));
  }
  add('admin.audit.actorAccount', text(actor.uid) || (typeof log.actorId === 'number' ? String(log.actorId) : ''));
  add('admin.audit.targetId', text(log.targetId));
  if (!action) add('admin.audit.actionCode', text(log.action));
  add('admin.audit.recordedAt', formatDateTime(log.createdAt));
  add('admin.audit.recordId', String(log.id));
  return result;
}
