import type { SettingsValue } from '@/lib/api/types';

/**
 * 站点设置的前端表单描述。
 *
 * 与后端 `internal/settings/schema.go` 的键一一对应。键名、类型、范围都在
 * 后端校验，这里只负责「怎么显示」——所以重复是必要的：后端不该知道
 * 「这个开关在界面上叫什么」。
 *
 * 顺序即分组内的显示顺序。
 */

export type SettingKind = 'string' | 'text' | 'bool' | 'int' | 'enum';

export interface SettingField {
  key: string;
  label: string;
  kind: SettingKind;
  hint?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  unit?: string;
  options?: { value: string; label: string }[];
}

export interface SettingGroup {
  id: string;
  title: string;
  description: string;
  fields: SettingField[];
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: 'site',
    title: '站点信息',
    description: '显示在浏览器标题、登录页与分享页页脚。',
    fields: [
      { key: 'site.name', label: '站点名称', kind: 'string', placeholder: 'wmind' },
      { key: 'site.logo', label: 'Logo 地址', kind: 'string', hint: '留空则使用默认图标。' },
      { key: 'site.description', label: '站点描述', kind: 'text', hint: '一句话介绍，出现在登录页与分享页。' },
      { key: 'site.icp', label: 'ICP 备案号', kind: 'string', hint: '留空则不显示备案信息。' },
      { key: 'site.base_url', label: '站点地址', kind: 'string', hint: '用于拼接分享链接的绝对地址；留空则按请求头推断。' },
    ],
  },
  {
    id: 'auth',
    title: '注册与登录',
    description: '关闭注册后，注册页不可访问，接口返回 403。',
    fields: [
      { key: 'auth.registration_enabled', label: '开放注册', kind: 'bool', hint: '关闭后任何人都无法自助注册，只能由管理员创建账号。' },
      {
        key: 'auth.default_role',
        label: '新用户默认角色',
        kind: 'enum',
        hint: '设为管理员等于「所有注册者都是管理员」，请谨慎。',
        options: [
          { value: 'user', label: '普通用户' },
          { value: 'admin', label: '管理员' },
        ],
      },
      { key: 'auth.password_min_length', label: '密码最小长度', kind: 'int', min: 8, max: 128, unit: '字符' },
      { key: 'auth.login_max_attempts', label: '登录失败上限', kind: 'int', min: 1, max: 100, unit: '次', hint: '连续失败达到该次数后锁定账号。' },
      { key: 'auth.login_lock_minutes', label: '锁定时长', kind: 'int', min: 1, max: 1440, unit: '分钟' },
    ],
  },
  {
    id: 'limit',
    title: '资源限制',
    description: '0 表示不限制。',
    fields: [
      { key: 'limit.maps_per_user', label: '单用户导图上限', kind: 'int', min: 0, max: 1000000, unit: '张' },
      { key: 'limit.upload_max_mb', label: '单文件上传上限', kind: 'int', min: 1, max: 1024, unit: 'MB' },
    ],
  },
  {
    id: 'feature',
    title: '功能开关',
    description: '影响导入导出与自定义模板的可用性。',
    fields: [
      { key: 'feature.import_enabled', label: '允许导入', kind: 'bool' },
      { key: 'feature.export_enabled', label: '允许导出', kind: 'bool' },
      { key: 'feature.user_template_enabled', label: '允许保存自定义模板', kind: 'bool' },
    ],
  },
  {
    id: 'share',
    title: '分享',
    description: '关闭公开链接后，已存在的分享链接全部失效。',
    fields: [
      { key: 'share.public_link_enabled', label: '允许创建分享链接', kind: 'bool' },
      { key: 'share.default_expire_days', label: '默认有效期', kind: 'int', min: 0, max: 3650, unit: '天', hint: '0 表示永久有效。' },
      { key: 'share.default_allow_download', label: '默认允许访问者导出', kind: 'bool' },
      { key: 'share.require_password', label: '强制分享链接设置密码', kind: 'bool' },
      { key: 'share.max_links_per_map', label: '单张导图分享上限', kind: 'int', min: 1, max: 1000, unit: '个' },
    ],
  },
];

/** 全部字段（扁平），用于校验与查找。 */
export const SETTING_FIELDS: SettingField[] = SETTING_GROUPS.flatMap((group) => group.fields);

export function findField(key: string): SettingField | undefined {
  return SETTING_FIELDS.find((field) => field.key === key);
}

/** 比较两份设置，返回发生变化的键值。只提交改动，避免覆盖别人刚改的项。 */
export function diffSettings(current: Record<string, SettingsValue>, draft: Record<string, SettingsValue>) {
  const patch: Record<string, SettingsValue> = {};
  for (const field of SETTING_FIELDS) {
    const before = current[field.key];
    const after = draft[field.key];
    if (after === undefined) continue;
    if (before !== after) patch[field.key] = after;
  }
  return patch;
}
