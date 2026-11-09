import { describe, expect, it } from 'vitest';
import {
  hasErrors,
  validateEmail,
  validatePassword,
  validatePasswordChange,
  validateProfile,
  validateRegistration,
  validateUsername,
} from './validation';

describe('validateUsername', () => {
  it('accepts 3–32 alphanumerics with dashes and underscores', () => {
    expect(validateUsername('abc')).toBeUndefined();
    expect(validateUsername('user_01-a')).toBeUndefined();
  });

  it('rejects short, long, and space-containing values', () => {
    expect(validateUsername('ab')).toMatch(/3–32/);
    expect(validateUsername('a'.repeat(33))).toMatch(/3–32/);
    expect(validateUsername('has space')).toMatch(/3–32/);
    expect(validateUsername('  ')).toBe('请填写用户名');
  });
});

describe('validateEmail', () => {
  it('accepts a normal address', () => {
    expect(validateEmail('a@b.co')).toBeUndefined();
  });

  it('rejects addresses without a domain or with spaces', () => {
    expect(validateEmail('a@b')).toMatch(/格式/);
    expect(validateEmail('a b@c.co')).toMatch(/格式/);
    expect(validateEmail('')).toBe('请填写邮箱');
  });
});

describe('validatePassword', () => {
  it('enforces the configured minimum by characters, not bytes', () => {
    // 4 个汉字 = 12 字节；按字节算会被误判为「已满足 8 位」。
    expect(validatePassword('密码密码密码', 8)).toMatch(/至少需要 8/);
    expect(validatePassword('密码密码密码密码', 8)).toBeUndefined();
  });

  it('rejects passwords beyond the bcrypt 72-byte cap', () => {
    expect(validatePassword('a'.repeat(73), 8)).toMatch(/72 字节/);
  });
});

describe('validateRegistration', () => {
  it('reports every invalid field at once', () => {
    const errors = validateRegistration(
      { username: 'ab', email: 'nope', password: '123', nickname: 'n'.repeat(33) },
      8,
    );
    expect(Object.keys(errors).sort()).toEqual(['email', 'nickname', 'password', 'username']);
    expect(hasErrors(errors)).toBe(true);
  });

  it('returns no errors for a valid form', () => {
    expect(validateRegistration(
      { username: 'alice', email: 'alice@example.com', password: 'correct-horse', nickname: 'Alice' },
      8,
    )).toEqual({});
  });
});

describe('validatePasswordChange', () => {
  it('flags mismatched confirmation', () => {
    const errors = validatePasswordChange(
      { oldPassword: 'old-password', newPassword: 'new-password', confirmPassword: 'new-passwerd' },
      8,
    );
    expect(errors.confirmPassword).toMatch(/不一致/);
  });

  it('flags reusing the current password', () => {
    const errors = validatePasswordChange(
      { oldPassword: 'same-password', newPassword: 'same-password', confirmPassword: 'same-password' },
      8,
    );
    expect(errors.newPassword).toMatch(/不能与当前密码相同/);
  });

  it('accepts a proper change', () => {
    expect(validatePasswordChange(
      { oldPassword: 'old-password', newPassword: 'brand-new-secret', confirmPassword: 'brand-new-secret' },
      8,
    )).toEqual({});
  });
});

describe('validateProfile', () => {
  it('allows an empty nickname (clearing it is legitimate)', () => {
    expect(validateProfile({ nickname: '', email: 'a@b.co' })).toEqual({});
  });

  it('rejects an over-long nickname', () => {
    expect(validateProfile({ nickname: '长'.repeat(33), email: 'a@b.co' }).nickname).toMatch(/32/);
  });
});
