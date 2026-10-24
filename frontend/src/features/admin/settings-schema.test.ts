import { describe, expect, it } from 'vitest';
import { findField, SETTING_GROUPS } from './settings-schema';

describe('设置说明的作用范围', () => {
  it('0 表示不限制只标注在允许零值的导图数量字段上', () => {
    expect(SETTING_GROUPS.find((group) => group.id === 'limit')).not.toHaveProperty('descriptionKey');
    expect(findField('limit.maps_per_user')).toMatchObject({ min: 0, hintKey: 'admin.settings.hintMapsPerUser' });
    expect(findField('limit.upload_max_mb')).toMatchObject({ min: 1 });
    expect(findField('limit.upload_max_mb')?.hintKey).toBeUndefined();
  });
});
