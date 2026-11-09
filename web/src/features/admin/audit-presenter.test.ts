import { describe, expect, it } from 'vitest';
import i18n from '@/lib/i18n';
import type { AuditLog } from '@/lib/api/types';
import { AUDIT_ACTIONS, presentAuditLog } from './audit-presenter';

const base: AuditLog = {
  id: 7, actorId: 1, actor: { uid: 'actor-uid', username: 'zhangsan', nickname: '张三' },
  action: 'share.create', targetType: 'share', targetId: 'share-uid', targetName: '项目计划',
  detail: { mapUid: 'map-uid', mapTitle: '项目计划', hasPassword: true, allowDownload: false, showNotes: false, expiresAt: null },
  ip: '203.0.113.4', createdAt: '2026-10-26T02:30:00Z',
};

describe('操作日志语义', () => {
  it('中英文覆盖全部已知动作，摘要显示操作者与对象而不是随机ID', async () => {
    for (const language of ['zh-CN', 'en-US']) {
      await i18n.changeLanguage(language);
      for (const { value, labelKey } of AUDIT_ACTIONS) {
        expect(i18n.exists(labelKey)).toBe(true);
        const result = presentAuditLog({ ...base, action: value }, i18n.t);
        expect(result.summary).toContain('张三');
        expect(result.summary).not.toContain('share-uid');
        expect(result.action).not.toBe(value);
      }
      const share = presentAuditLog(base, i18n.t);
      expect(share.summary).toContain('项目计划');
      expect(share.summary).not.toContain('share.create');
    }
  });

  it('设置和AI字段使用表单名称，未知字段只给通用兜底', async () => {
    for (const language of ['zh-CN', 'en-US']) {
      await i18n.changeLanguage(language);
      const result = presentAuditLog({ ...base, action: 'settings.update', targetType: 'settings', detail: { keys: ['site.brand', 'ai.config', 'not.a.known.setting', 'site.brand'] } }, i18n.t);
      expect(result.summary).toContain(language === 'zh-CN' ? '品牌标识' : 'Brand');
      expect(result.summary).toContain('AI');
      for (const key of ['site.brand', 'ai.config', 'not.a.known.setting']) expect(result.summary).not.toContain(key);
      expect(result.details.some((item) => item.value.includes('not.a.known.setting'))).toBe(false);
    }
  });

  it('角色变化显示完整前后值，未知枚举不能伪装成普通用户', async () => {
    await i18n.changeLanguage('zh-CN');
    const result = presentAuditLog({ ...base, action: 'user.role', targetType: 'user', targetName: '李四', detail: { from: 'user', to: 'admin' } }, i18n.t);
    expect(result.summary).toContain('李四');
    expect(result.summary).toContain('普通用户');
    expect(result.summary).toContain('管理员');
    expect(presentAuditLog({ ...base, action: 'user.role', detail: { from: 'INVALID', to: 'admin' } }, i18n.t).summary).not.toContain('INVALID');
  });

  it('详情只渲染允许字段，敏感值和任意JSON不显示', async () => {
    await i18n.changeLanguage('zh-CN');
    const result = presentAuditLog({ ...base, detail: { ...base.detail as object, password: 'password-secret', apiKey: 'api-key-secret', token: 'token-secret', nested: { secret: 'nested-secret' } } }, i18n.t);
    const output = JSON.stringify(result);
    for (const secret of ['password-secret', 'api-key-secret', 'token-secret', 'nested-secret']) expect(output).not.toContain(secret);
    expect(result.details.some((item) => item.value === 'share-uid')).toBe(true);
    expect(result.details.some((item) => item.value === 'map-uid')).toBe(true);
    expect(result.details.some((item) => item.value === '已启用')).toBe(true);
    expect(result.details.some((item) => item.value === '不允许')).toBe(true);
    expect(result.details.some((item) => item.value === '永久有效')).toBe(true);
  });

  it('历史缺失、未知动作与畸形详情均有明确兜底', async () => {
    await i18n.changeLanguage('zh-CN');
    for (const detail of [null, 'old log text', 7, [], { keys: [null, {}, 4], actor: { nickname: { unsafe: true } }, mapTitle: { unsafe: true } }]) {
      const result = presentAuditLog({ ...base, actor: null, targetName: '', action: 'future.action', detail }, i18n.t);
      expect(result.summary).toContain('未知操作者');
      expect(result.summary).not.toContain('future.action');
      expect(JSON.stringify(result)).not.toContain('[object Object]');
      expect(result.summary).not.toContain('share-uid');
    }
  });

  it('与对象原型属性同名的历史动作或设置键不会被误当作翻译映射', async () => {
    await i18n.changeLanguage('zh-CN');
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(presentAuditLog({ ...base, action: key }, i18n.t).summary).toContain('执行了一项操作');
      expect(presentAuditLog({ ...base, action: 'settings.update', detail: { keys: [key] } }, i18n.t).summary).toContain('其他设置项');
    }
  });

  it('旧分享记录可用mapTitle，缺失名称时不编造标题', async () => {
    await i18n.changeLanguage('zh-CN');
    expect(presentAuditLog({ ...base, targetName: undefined }, i18n.t).summary).toContain('项目计划');
    const unknown = presentAuditLog({ ...base, targetName: '', detail: {} }, i18n.t);
    expect(unknown.summary).toContain('未知导图');
    expect(unknown.summary).not.toContain('项目计划');
  });
});
