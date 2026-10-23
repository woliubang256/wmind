import type { SettingsValue } from '@/lib/api/types';

/**
 * 站点设置的前端表单描述。
 *
 * 与后端 `internal/settings/schema.go` 的键一一对应。键名、类型、范围都在
 * 后端校验，这里只负责「怎么显示」——所以重复是必要的：后端不该知道
 * 「这个开关在界面上叫什么」。
 *
 * **只存 i18n key，不存文案。** 这里是一张模块级常量表，在模块求值时就固定
 * 下来了；把中文写进来，切换语言后整张表不会跟着变——而这张表恰好覆盖了
 * 20 个字段的标题、说明与单位，是最显眼的一屏。文案统一在 `admin.settings.*`
 * 下，由 `settings-page.tsx` 在渲染时 `t()`。
 *
 * 顺序即分组内的显示顺序。
 */

export type SettingKind = 'string' | 'text' | 'bool' | 'int' | 'enum';

export interface SettingField {
  key: string;
  labelKey: string;
  kind: SettingKind;
  hintKey?: string;
  placeholder?: string;
  min?: number;
  max?: number;
  unitKey?: string;
  options?: { value: string; labelKey: string }[];
}

export interface SettingGroup {
  id: string;
  titleKey: string;
  descriptionKey: string;
  fields: SettingField[];
}

export const SETTING_GROUPS: SettingGroup[] = [
  {
    id: 'site',
    titleKey: 'admin.settings.groupSiteTitle',
    descriptionKey: 'admin.settings.groupSiteDescription',
    fields: [
      { key: 'site.name', labelKey: 'admin.settings.fieldSiteName', kind: 'string', placeholder: 'wmind' },
      {
        key: 'site.brand',
        labelKey: 'admin.settings.fieldSiteBrand',
        kind: 'string',
        hintKey: 'admin.settings.hintSiteBrand',
        placeholder: 'wmind',
      },
      { key: 'site.logo', labelKey: 'admin.settings.fieldSiteLogo', kind: 'string', hintKey: 'admin.settings.hintSiteLogo' },
      {
        key: 'site.description',
        labelKey: 'admin.settings.fieldSiteDescription',
        kind: 'text',
        hintKey: 'admin.settings.hintSiteDescription',
      },
      { key: 'site.icp', labelKey: 'admin.settings.fieldSiteIcp', kind: 'string', hintKey: 'admin.settings.hintSiteIcp' },
      {
        key: 'site.base_url',
        labelKey: 'admin.settings.fieldSiteBaseUrl',
        kind: 'string',
        hintKey: 'admin.settings.hintSiteBaseUrl',
      },
    ],
  },
  {
    id: 'auth',
    titleKey: 'admin.settings.groupAuthTitle',
    descriptionKey: 'admin.settings.groupAuthDescription',
    fields: [
      {
        key: 'auth.registration_enabled',
        labelKey: 'admin.settings.fieldRegistrationEnabled',
        kind: 'bool',
        hintKey: 'admin.settings.hintRegistrationEnabled',
      },
      {
        key: 'auth.default_role',
        labelKey: 'admin.settings.fieldDefaultRole',
        kind: 'enum',
        hintKey: 'admin.settings.hintDefaultRole',
        options: [
          { value: 'user', labelKey: 'admin.settings.roleUser' },
          { value: 'admin', labelKey: 'admin.settings.roleAdmin' },
        ],
      },
      {
        key: 'auth.password_min_length',
        labelKey: 'admin.settings.fieldPasswordMinLength',
        kind: 'int',
        min: 8,
        max: 128,
        unitKey: 'admin.settings.unitChars',
      },
      {
        key: 'auth.login_max_attempts',
        labelKey: 'admin.settings.fieldLoginMaxAttempts',
        kind: 'int',
        min: 1,
        max: 100,
        unitKey: 'admin.settings.unitTimes',
        hintKey: 'admin.settings.hintLoginMaxAttempts',
      },
      {
        key: 'auth.login_lock_minutes',
        labelKey: 'admin.settings.fieldLoginLockMinutes',
        kind: 'int',
        min: 1,
        max: 1440,
        unitKey: 'admin.settings.unitMinutes',
      },
    ],
  },
  {
    id: 'limit',
    titleKey: 'admin.settings.groupLimitTitle',
    descriptionKey: 'admin.settings.groupLimitDescription',
    fields: [
      {
        key: 'limit.maps_per_user',
        labelKey: 'admin.settings.fieldMapsPerUser',
        kind: 'int',
        min: 0,
        max: 1000000,
        unitKey: 'admin.settings.unitMaps',
      },
      {
        key: 'limit.upload_max_mb',
        labelKey: 'admin.settings.fieldUploadMaxMb',
        kind: 'int',
        min: 1,
        max: 1024,
        unitKey: 'admin.settings.unitMb',
      },
    ],
  },
  {
    id: 'trash',
    titleKey: 'admin.settings.groupTrashTitle',
    descriptionKey: 'admin.settings.groupTrashDescription',
    fields: [
      {
        key: 'trash.retention_days',
        labelKey: 'admin.settings.fieldTrashRetentionDays',
        kind: 'int',
        min: 1,
        max: 3650,
        unitKey: 'admin.settings.unitDays',
        hintKey: 'admin.settings.hintTrashRetentionDays',
      },
    ],
  },
  {
    id: 'feature',
    titleKey: 'admin.settings.groupFeatureTitle',
    descriptionKey: 'admin.settings.groupFeatureDescription',
    fields: [
      { key: 'feature.import_enabled', labelKey: 'admin.settings.fieldImportEnabled', kind: 'bool' },
      { key: 'feature.export_enabled', labelKey: 'admin.settings.fieldExportEnabled', kind: 'bool' },
      { key: 'feature.user_template_enabled', labelKey: 'admin.settings.fieldUserTemplateEnabled', kind: 'bool' },
    ],
  },
  {
    id: 'share',
    titleKey: 'admin.settings.groupShareTitle',
    descriptionKey: 'admin.settings.groupShareDescription',
    fields: [
      { key: 'share.public_link_enabled', labelKey: 'admin.settings.fieldPublicLinkEnabled', kind: 'bool' },
      {
        key: 'share.default_expire_days',
        labelKey: 'admin.settings.fieldDefaultExpireDays',
        kind: 'int',
        min: 0,
        max: 3650,
        unitKey: 'admin.settings.unitDays',
        hintKey: 'admin.settings.hintDefaultExpireDays',
      },
      { key: 'share.default_allow_download', labelKey: 'admin.settings.fieldDefaultAllowDownload', kind: 'bool' },
      { key: 'share.require_password', labelKey: 'admin.settings.fieldRequirePassword', kind: 'bool' },
      {
        key: 'share.max_links_per_map',
        labelKey: 'admin.settings.fieldMaxLinksPerMap',
        kind: 'int',
        min: 1,
        max: 1000,
        unitKey: 'admin.settings.unitLinks',
      },
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
