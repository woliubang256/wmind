import { useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { UserAvatar } from '@/components/user-avatar';
import { Input, SelectField, TextField } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Modal } from '@/components/ui/modal';
import { Badge, EmptyState, PageHeader, Panel } from '@/components/ui/panel';
import { useCurrentUser } from '@/app/auth';
import { useSiteConfig } from '@/features/site/use-site-config';
import { adminApi, type AdminUserQuery } from '@/lib/api/endpoints';
import type { Role, User, UserStatus } from '@/lib/api/types';
import { ApiError, codeToField, fieldErrorsFrom } from '@/lib/api/errors';
import { formatDateTime, formatNumber, formatRelative } from '@/lib/format';
import { hasErrors, validateEmail, validateNickname, validatePassword, validateUsername, type FieldErrors } from '@/lib/validation';
import { adminKeys } from './queries';

const PAGE_SIZE = 20;

/**
 * 角色与状态的显示文案。
 *
 * 存 key 而不是文案：这两张表在模块求值时就定下来了，把中文写进来以后
 * 切换语言不会跟着变——而它们出现在每一行的徽章里，是最容易被看见的那一处。
 */
const ROLE_LABEL_KEY: Record<Role, string> = {
  user: 'admin.users.roleUser',
  admin: 'admin.users.roleAdmin',
};

const STATUS_META: Record<UserStatus, { labelKey: string; tone: 'success' | 'warning' | 'danger' }> = {
  active: { labelKey: 'admin.users.statusActive', tone: 'success' },
  disabled: { labelKey: 'admin.users.statusDisabled', tone: 'danger' },
  pending: { labelKey: 'admin.users.statusPending', tone: 'warning' },
};

export function AdminUsersPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const { data: currentUser } = useCurrentUser();
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<AdminUserQuery>({ page: 1, pageSize: PAGE_SIZE });
  const [creating, setCreating] = useState(false);
  const [editing, setEditing] = useState<User | null>(null);
  const [resetting, setResetting] = useState<User | null>(null);
  const [deleting, setDeleting] = useState<User | null>(null);

  const users = useQuery({
    queryKey: adminKeys.users(filters),
    queryFn: () => adminApi.listUsers(filters),
    // 翻页时保留上一页内容：否则表格会先塌成空白再长回来，滚动位置也跟着跳。
    placeholderData: keepPreviousData,
  });

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: adminKeys.usersRoot });
    void queryClient.invalidateQueries({ queryKey: adminKeys.stats });
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFilters((prev) => ({ ...prev, keyword: search.trim() || undefined, page: 1 }));
  };

  const patchFilter = (patch: Partial<AdminUserQuery>) => {
    setFilters((prev) => ({ ...prev, ...patch, page: 1 }));
  };

  const roleOptions = [
    { value: '', label: t('admin.users.allRoles') },
    { value: 'user', label: t(ROLE_LABEL_KEY.user) },
    { value: 'admin', label: t(ROLE_LABEL_KEY.admin) },
  ];

  const statusOptions = [
    { value: '', label: t('admin.users.allStatuses') },
    { value: 'active', label: t(STATUS_META.active.labelKey) },
    { value: 'disabled', label: t(STATUS_META.disabled.labelKey) },
    { value: 'pending', label: t(STATUS_META.pending.labelKey) },
  ];

  const items = users.data?.items ?? [];
  const pagination = users.data?.pagination;

  return (
    <div className="space-y-5">
      <PageHeader
        title={t('admin.users.title')}
        description={t('admin.users.description')}
        actions={
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" className="size-4" />
            {t('admin.users.create')}
          </Button>
        }
      />

      <Panel
        bodyClassName="p-0"
        footer={
          pagination ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>
                {t('admin.users.total', { count: formatNumber(pagination.total) })}
                {pagination.totalPages > 1
                  ? ` · ${t('admin.users.page', { page: pagination.page, total: pagination.totalPages })}`
                  : ''}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => setFilters((prev) => ({ ...prev, page: (prev.page ?? 1) - 1 }))}
                >
                  <Icon name="chevron-left" className="size-4" />
                  {t('admin.users.prev')}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => setFilters((prev) => ({ ...prev, page: (prev.page ?? 1) + 1 }))}
                >
                  {t('admin.users.next')}
                  <Icon name="chevron-right" className="size-4" />
                </Button>
              </div>
            </div>
          ) : null
        }
      >
        <div className="flex flex-wrap items-end gap-3 border-b border-border/70 px-5 py-4">
          <form onSubmit={submitSearch} className="flex min-w-56 flex-1 items-center gap-2">
            <Input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder={t('admin.users.searchPlaceholder')}
              aria-label={t('admin.users.searchLabel')}
            />
            <Button type="submit" variant="outline" size="icon" aria-label={t('admin.users.search')}>
              <Icon name="search" className="size-4" />
            </Button>
          </form>
          <Select
            aria-label={t('admin.users.filterRole')}
            value={filters.role ?? ''}
            options={roleOptions}
            onChange={(next) => patchFilter({ role: next || undefined })}
            className="w-36"
          />
          <Select
            aria-label={t('admin.users.filterStatus')}
            value={filters.status ?? ''}
            options={statusOptions}
            onChange={(next) => patchFilter({ status: next || undefined })}
            className="w-36"
          />
        </div>

        {users.isError ? (
          <div className="p-5">
            <EmptyState
              icon="alert"
              title={t('admin.users.loadFailed')}
              description={users.error instanceof Error ? users.error.message : undefined}
              action={
                <Button variant="outline" size="sm" onClick={() => void users.refetch()}>
                  {t('common.retry')}
                </Button>
              }
            />
          </div>
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon="users"
              title={
                users.isLoading
                  ? t('common.loading')
                  : filters.keyword
                    ? t('admin.users.emptySearch')
                    : t('admin.users.empty')
              }
              description={
                filters.keyword ? t('admin.users.emptySearchHint') : t('admin.users.emptyHint')
              }
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-3xl border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-3 font-medium">{t('admin.users.colUser')}</th>
                  <th className="px-3 py-3 font-medium">{t('admin.users.colRole')}</th>
                  <th className="px-3 py-3 font-medium">{t('admin.users.colStatus')}</th>
                  <th className="hidden px-3 py-3 font-medium md:table-cell">{t('admin.users.colMaps')}</th>
                  <th className="hidden px-3 py-3 font-medium lg:table-cell">{t('admin.users.colLastLogin')}</th>
                  <th className="px-5 py-3 text-right font-medium">{t('admin.users.colActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/70">
                {items.map((user) => {
                  const isSelf = user.uid === currentUser?.uid;
                  const status = STATUS_META[user.status] ?? STATUS_META.active;
                  return (
                    <tr key={user.uid} className="align-middle transition-colors hover:bg-accent/40">
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-3">
                          <UserAvatar user={user} className="size-9 rounded-xl" />
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {user.nickname || user.username}
                              {isSelf ? <span className="ml-2 text-xs font-normal text-muted-foreground">{t('admin.users.you')}</span> : null}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={user.role === 'admin' ? 'primary' : 'neutral'}>{t(ROLE_LABEL_KEY[user.role])}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={status.tone}>{t(status.labelKey)}</Badge>
                      </td>
                      <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">{formatNumber(user.mapCount)}</td>
                      <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell" title={formatDateTime(user.lastLoginAt)}>
                        {formatRelative(user.lastLoginAt)}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('admin.users.editLabel', { name: user.username })}
                            title={t('admin.users.edit')}
                            onClick={() => setEditing(user)}
                          >
                            <Icon name="pencil" className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('admin.users.resetLabel', { name: user.username })}
                            title={isSelf ? t('admin.users.cannotResetSelf') : t('admin.users.resetPassword')}
                            disabled={isSelf}
                            onClick={() => setResetting(user)}
                          >
                            <Icon name="key" className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('admin.users.deleteLabel', { name: user.username })}
                            title={isSelf ? t('admin.users.cannotDeleteSelf') : t('admin.users.delete')}
                            disabled={isSelf}
                            onClick={() => setDeleting(user)}
                            className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                          >
                            <Icon name="trash" className="size-4" />
                          </Button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      {/* key 随目标用户变化：切换编辑对象时组件重挂载，表单状态自然重置，
          不需要在 effect 里手工同步「现在是谁」。 */}
      <UserEditor key={`create-${creating}`} open={creating} user={null} onClose={() => setCreating(false)} onSaved={refresh} />
      <UserEditor
        key={editing?.uid ?? 'edit-none'}
        open={Boolean(editing)}
        user={editing}
        onClose={() => setEditing(null)}
        onSaved={refresh}
      />
      <ResetPasswordDialog key={resetting?.uid ?? 'reset-none'} user={resetting} onClose={() => setResetting(null)} onDone={refresh} />
      <DeleteUserDialog key={deleting?.uid ?? 'delete-none'} user={deleting} onClose={() => setDeleting(null)} onDone={refresh} />
    </div>
  );
}

interface UserEditorProps {
  open: boolean;
  /** null 表示新建。 */
  user: User | null;
  onClose: () => void;
  onSaved: () => void;
}

function UserEditor({ open, user, onClose, onSaved }: UserEditorProps) {
  const { t } = useTranslation();
  const { config } = useSiteConfig();
  const isCreate = user === null;
  const [form, setForm] = useState(() => ({
    username: user?.username ?? '',
    email: user?.email ?? '',
    password: '',
    nickname: user?.nickname ?? '',
    role: (user?.role ?? 'user') as Role,
    status: (user?.status ?? 'active') as UserStatus,
  }));
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: () => {
      if (user) {
        return adminApi.updateUser(user.uid, {
          nickname: form.nickname,
          email: form.email,
          role: form.role,
          status: form.status,
        });
      }
      return adminApi.createUser({
        username: form.username.trim(),
        email: form.email.trim(),
        password: form.password,
        nickname: form.nickname.trim() || undefined,
        role: form.role,
      });
    },
    onSuccess: () => {
      toast.success(isCreate ? t('admin.users.created') : t('admin.users.updated'));
      onSaved();
      onClose();
    },
    onError: (error) => {
      if (error instanceof ApiError) {
        const fields = fieldErrorsFrom(error);
        if (Object.keys(fields).length > 0) {
          setErrors(fields);
          return;
        }
        const field = codeToField(error.code);
        if (field) {
          setErrors({ [field]: error.message });
          return;
        }
      }
      toast.error(error instanceof Error ? error.message : t('admin.users.saveFailed'));
    },
  });

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const nextErrors: FieldErrors = {};
    if (isCreate) {
      const username = validateUsername(form.username);
      if (username) nextErrors.username = username;
      const password = validatePassword(form.password, config.passwordMinLength);
      if (password) nextErrors.password = password;
    }
    const email = validateEmail(form.email);
    if (email) nextErrors.email = email;
    const nickname = validateNickname(form.nickname);
    if (nickname) nextErrors.nickname = nickname;
    setErrors(nextErrors);
    if (hasErrors(nextErrors)) return;
    save.mutate();
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isCreate ? t('admin.users.createTitle') : t('admin.users.editTitle', { name: user?.username ?? '' })}
      description={isCreate ? t('admin.users.createDescription') : t('admin.users.editDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" form="user-editor-form" disabled={save.isPending}>
            {save.isPending ? t('common.saving') : t('common.save')}
          </Button>
        </>
      }
    >
      <form id="user-editor-form" onSubmit={submit} className="space-y-4" noValidate>
        {isCreate ? (
          <TextField
            label={t('admin.users.username')}
            value={form.username}
            onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
            error={errors.username}
            hint={t('admin.users.usernameHint')}
            autoComplete="off"
          />
        ) : (
          <TextField
            label={t('admin.users.username')}
            value={form.username}
            readOnly
            disabled
            hint={t('admin.users.usernameReadonlyHint')}
          />
        )}
        <TextField
          label={t('admin.users.email')}
          type="email"
          value={form.email}
          onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
          error={errors.email}
          autoComplete="off"
        />
        {isCreate ? (
          <TextField
            label={t('admin.users.initialPassword')}
            type="password"
            value={form.password}
            onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
            error={errors.password}
            hint={t('admin.users.passwordHint', { min: config.passwordMinLength })}
            autoComplete="new-password"
          />
        ) : null}
        <TextField
          label={t('admin.users.nickname')}
          value={form.nickname}
          onChange={(event) => setForm((prev) => ({ ...prev, nickname: event.target.value }))}
          error={errors.nickname}
          hint={t('admin.users.nicknameHint')}
        />
        <SelectField
          label={t('admin.users.role')}
          value={form.role}
          onChange={(role) => setForm((prev) => ({ ...prev, role }))}
          options={[
            { value: 'user', label: t(ROLE_LABEL_KEY.user) },
            { value: 'admin', label: t(ROLE_LABEL_KEY.admin) },
          ]}
          error={errors.role}
          hint={form.role === 'admin' ? t('admin.users.roleAdminHint') : undefined}
        />
        {isCreate ? null : (
          <SelectField
            label={t('admin.users.status')}
            value={form.status}
            onChange={(status) => setForm((prev) => ({ ...prev, status }))}
            options={[
              { value: 'active', label: t(STATUS_META.active.labelKey) },
              { value: 'disabled', label: t(STATUS_META.disabled.labelKey) },
              { value: 'pending', label: t(STATUS_META.pending.labelKey) },
            ]}
            error={errors.status}
            hint={t('admin.users.statusDisabledHint')}
          />
        )}
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: User | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'generate' | 'custom'>('generate');
  const [password, setPassword] = useState('');
  const [result, setResult] = useState<{ password: string; generated: boolean } | null>(null);

  const reset = useMutation({
    mutationFn: () => adminApi.resetPassword(user!.uid, mode === 'custom' ? password : undefined),
    onSuccess: (data) => {
      setResult(data);
      onDone();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t('admin.users.resetFailed'));
    },
  });

  const close = () => {
    // 结果状态不必手工清空：父组件用 uid 做 key，关闭后重挂载即回到初始态。
    onClose();
  };

  const copy = async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result.password);
      toast.success(t('admin.users.passwordCopied'));
    } catch {
      // 非 HTTPS 或权限被拒时 clipboard 不可用：让用户手动选中复制。
      toast.error(t('admin.users.copyFailed'));
    }
  };

  return (
    <Modal
      open={Boolean(user)}
      onClose={close}
      // 新密码只在这次响应里出现，关掉就查不到了：必须让用户先复制。
      dismissible={result === null}
      title={result ? t('admin.users.resetDoneTitle') : t('admin.users.resetTitle', { name: user?.username ?? '' })}
      description={result ? t('admin.users.resetDoneDescription') : t('admin.users.resetDescription')}
      footer={
        result ? (
          <>
            <Button variant="outline" onClick={() => void copy()}>
              <Icon name="copy" className="size-4" />
              {t('admin.users.copyPassword')}
            </Button>
            <Button onClick={close}>{t('admin.users.savedPassword')}</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              {t('common.cancel')}
            </Button>
            <Button disabled={reset.isPending || (mode === 'custom' && password.length === 0)} onClick={() => reset.mutate()}>
              {reset.isPending ? t('admin.users.processing') : t('admin.users.resetPassword')}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="space-y-3">
          <div className="flex items-center gap-2 rounded-xl border border-border bg-muted/60 px-4 py-3">
            <code className="flex-1 break-all font-mono text-base tracking-wide">{result.password}</code>
            <Icon name="key" className="size-4 shrink-0 text-muted-foreground" />
          </div>
          <p className="flex items-start gap-2 text-xs text-muted-foreground">
            <Icon name="alert" className="mt-0.5 size-3.5 shrink-0 text-amber-600 dark:text-amber-400" />
            {result.generated ? t('admin.users.generatedNote') : t('admin.users.customNote')}
            {t('admin.users.handoverHint')}
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                { value: 'generate', labelKey: 'admin.users.modeGenerate', hintKey: 'admin.users.modeGenerateHint' },
                { value: 'custom', labelKey: 'admin.users.modeCustom', hintKey: 'admin.users.modeCustomHint' },
              ] as const
            ).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setMode(option.value)}
                aria-pressed={mode === option.value}
                className={`rounded-xl border px-3 py-3 text-left text-sm transition ${
                  mode === option.value
                    ? 'border-primary bg-primary/10 font-medium text-primary'
                    : 'border-border hover:bg-accent hover:text-accent-foreground'
                }`}
              >
                <span className="block">{t(option.labelKey)}</span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{t(option.hintKey)}</span>
              </button>
            ))}
          </div>
          {mode === 'custom' ? (
            <TextField
              label={t('admin.users.newPassword')}
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="new-password"
            />
          ) : null}
        </div>
      )}
    </Modal>
  );
}

function DeleteUserDialog({ user, onClose, onDone }: { user: User | null; onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [strategy, setStrategy] = useState<'delete' | 'keep'>('delete');

  const remove = useMutation({
    mutationFn: () => adminApi.deleteUser(user!.uid, strategy),
    onSuccess: () => {
      toast.success(t('admin.users.deleted'));
      onDone();
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : t('admin.users.deleteFailed'));
    },
  });

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title={t('admin.users.deleteTitle', { name: user?.username ?? '' })}
      description={t('admin.users.deleteDescription')}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? t('admin.users.deleting') : t('admin.users.confirmDelete')}
          </Button>
        </>
      }
    >
      <SelectField
        label={t('admin.users.mapsLabel')}
        value={strategy}
        onChange={setStrategy}
        options={[
          { value: 'delete', label: t('admin.users.mapsDelete') },
          { value: 'keep', label: t('admin.users.mapsKeep') },
        ]}
        hint={t('admin.users.mapsHint')}
      />
    </Modal>
  );
}
