import { useState, type FormEvent } from 'react';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import { Input, Select, SelectField, TextField } from '@/components/ui/input';
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

const ROLE_LABEL: Record<Role, string> = { user: '普通用户', admin: '管理员' };

const STATUS_META: Record<UserStatus, { label: string; tone: 'success' | 'warning' | 'danger' }> = {
  active: { label: '正常', tone: 'success' },
  disabled: { label: '已禁用', tone: 'danger' },
  pending: { label: '待激活', tone: 'warning' },
};

const ROLE_OPTIONS = [
  { value: '', label: '全部角色' },
  { value: 'user', label: ROLE_LABEL.user },
  { value: 'admin', label: ROLE_LABEL.admin },
];

const STATUS_OPTIONS = [
  { value: '', label: '全部状态' },
  { value: 'active', label: STATUS_META.active.label },
  { value: 'disabled', label: STATUS_META.disabled.label },
  { value: 'pending', label: STATUS_META.pending.label },
];

export function AdminUsersPage() {
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

  const items = users.data?.items ?? [];
  const pagination = users.data?.pagination;

  return (
    <div className="space-y-5">
      <PageHeader
        title="用户管理"
        description="创建、编辑、禁用账号，或为忘记密码的用户重置密码。"
        actions={
          <Button onClick={() => setCreating(true)}>
            <Icon name="plus" className="size-4" />
            新建用户
          </Button>
        }
      />

      <Panel
        bodyClassName="p-0"
        footer={
          pagination ? (
            <div className="flex flex-wrap items-center justify-between gap-3 text-sm text-muted-foreground">
              <span>
                共 {formatNumber(pagination.total)} 位用户
                {pagination.totalPages > 1 ? ` · 第 ${pagination.page} / ${pagination.totalPages} 页` : ''}
              </span>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page <= 1}
                  onClick={() => setFilters((prev) => ({ ...prev, page: (prev.page ?? 1) - 1 }))}
                >
                  <Icon name="chevron-left" className="size-4" />
                  上一页
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={pagination.page >= pagination.totalPages}
                  onClick={() => setFilters((prev) => ({ ...prev, page: (prev.page ?? 1) + 1 }))}
                >
                  下一页
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
              placeholder="搜索用户名、邮箱或昵称"
              aria-label="搜索用户"
            />
            <Button type="submit" variant="outline" size="icon" aria-label="搜索">
              <Icon name="search" className="size-4" />
            </Button>
          </form>
          <Select
            aria-label="按角色筛选"
            value={filters.role ?? ''}
            onChange={(event) => patchFilter({ role: event.target.value || undefined })}
            className="w-36"
          >
            {ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Select
            aria-label="按状态筛选"
            value={filters.status ?? ''}
            onChange={(event) => patchFilter({ status: event.target.value || undefined })}
            className="w-36"
          >
            {STATUS_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
        </div>

        {users.isError ? (
          <div className="p-5">
            <EmptyState
              icon="alert"
              title="用户列表加载失败"
              description={users.error instanceof Error ? users.error.message : undefined}
              action={
                <Button variant="outline" size="sm" onClick={() => void users.refetch()}>
                  重试
                </Button>
              }
            />
          </div>
        ) : items.length === 0 ? (
          <div className="p-5">
            <EmptyState
              icon="users"
              title={users.isLoading ? '正在加载…' : filters.keyword ? '没有匹配的用户' : '还没有用户'}
              description={filters.keyword ? '换个关键词，或清空筛选条件。' : '新建的账号会出现在这里。'}
            />
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-3xl border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                  <th className="px-5 py-3 font-medium">用户</th>
                  <th className="px-3 py-3 font-medium">角色</th>
                  <th className="px-3 py-3 font-medium">状态</th>
                  <th className="hidden px-3 py-3 font-medium md:table-cell">导图</th>
                  <th className="hidden px-3 py-3 font-medium lg:table-cell">最近登录</th>
                  <th className="px-5 py-3 text-right font-medium">操作</th>
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
                          {user.avatarUrl ? (
                            <img src={user.avatarUrl} alt="" className="size-9 shrink-0 rounded-xl object-cover ring-1 ring-border" />
                          ) : (
                            <span className="grid size-9 shrink-0 place-items-center rounded-xl bg-secondary text-secondary-foreground">
                              <Icon name="user" className="size-4" />
                            </span>
                          )}
                          <div className="min-w-0">
                            <p className="truncate font-medium">
                              {user.nickname || user.username}
                              {isSelf ? <span className="ml-2 text-xs font-normal text-muted-foreground">（你）</span> : null}
                            </p>
                            <p className="truncate text-xs text-muted-foreground">{user.email}</p>
                          </div>
                        </div>
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={user.role === 'admin' ? 'primary' : 'neutral'}>{ROLE_LABEL[user.role]}</Badge>
                      </td>
                      <td className="px-3 py-3">
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </td>
                      <td className="hidden px-3 py-3 text-muted-foreground md:table-cell">{formatNumber(user.mapCount)}</td>
                      <td className="hidden px-3 py-3 text-muted-foreground lg:table-cell" title={formatDateTime(user.lastLoginAt)}>
                        {formatRelative(user.lastLoginAt)}
                      </td>
                      <td className="px-5 py-3">
                        <div className="flex items-center justify-end gap-1">
                          <Button variant="ghost" size="icon" aria-label={`编辑 ${user.username}`} title="编辑" onClick={() => setEditing(user)}>
                            <Icon name="pencil" className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`重置 ${user.username} 的密码`}
                            title={isSelf ? '不能重置自己的密码' : '重置密码'}
                            disabled={isSelf}
                            onClick={() => setResetting(user)}
                          >
                            <Icon name="key" className="size-4" />
                          </Button>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={`删除 ${user.username}`}
                            title={isSelf ? '不能删除自己' : '删除用户'}
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
      toast.success(isCreate ? '用户已创建' : '用户已更新');
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
      toast.error(error instanceof Error ? error.message : '保存失败');
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
      title={isCreate ? '新建用户' : `编辑 ${user?.username ?? ''}`}
      description={isCreate ? '创建后即可用这个密码登录，建议提醒用户尽快修改。' : '用户名不可修改；改邮箱需要唯一。'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button type="submit" form="user-editor-form" disabled={save.isPending}>
            {save.isPending ? '保存中…' : '保存'}
          </Button>
        </>
      }
    >
      <form id="user-editor-form" onSubmit={submit} className="space-y-4" noValidate>
        {isCreate ? (
          <TextField
            label="用户名"
            value={form.username}
            onChange={(event) => setForm((prev) => ({ ...prev, username: event.target.value }))}
            error={errors.username}
            hint="3–32 位字母、数字、下划线或短横线，创建后不可修改。"
            autoComplete="off"
          />
        ) : (
          <TextField label="用户名" value={form.username} readOnly disabled hint="用户名不可修改。" />
        )}
        <TextField
          label="邮箱"
          type="email"
          value={form.email}
          onChange={(event) => setForm((prev) => ({ ...prev, email: event.target.value }))}
          error={errors.email}
          autoComplete="off"
        />
        {isCreate ? (
          <TextField
            label="初始密码"
            type="password"
            value={form.password}
            onChange={(event) => setForm((prev) => ({ ...prev, password: event.target.value }))}
            error={errors.password}
            hint={`至少 ${config.passwordMinLength} 个字符。`}
            autoComplete="new-password"
          />
        ) : null}
        <TextField
          label="昵称"
          value={form.nickname}
          onChange={(event) => setForm((prev) => ({ ...prev, nickname: event.target.value }))}
          error={errors.nickname}
          hint="留空则显示用户名。"
        />
        <SelectField
          label="角色"
          value={form.role}
          onChange={(event) => setForm((prev) => ({ ...prev, role: event.target.value as Role }))}
          options={[
            { value: 'user', label: ROLE_LABEL.user },
            { value: 'admin', label: ROLE_LABEL.admin },
          ]}
          error={errors.role}
          hint={form.role === 'admin' ? '管理员可以管理所有用户与站点设置。' : undefined}
        />
        {isCreate ? null : (
          <SelectField
            label="状态"
            value={form.status}
            onChange={(event) => setForm((prev) => ({ ...prev, status: event.target.value as UserStatus }))}
            options={[
              { value: 'active', label: STATUS_META.active.label },
              { value: 'disabled', label: STATUS_META.disabled.label },
              { value: 'pending', label: STATUS_META.pending.label },
            ]}
            error={errors.status}
            hint="设为禁用会立刻踢下线，已签发的访问令牌全部失效。"
          />
        )}
      </form>
    </Modal>
  );
}

function ResetPasswordDialog({ user, onClose, onDone }: { user: User | null; onClose: () => void; onDone: () => void }) {
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
      toast.error(error instanceof Error ? error.message : '重置失败');
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
      toast.success('密码已复制');
    } catch {
      // 非 HTTPS 或权限被拒时 clipboard 不可用：让用户手动选中复制。
      toast.error('复制失败，请手动选中密码复制。');
    }
  };

  return (
    <Modal
      open={Boolean(user)}
      onClose={close}
      // 新密码只在这次响应里出现，关掉就查不到了：必须让用户先复制。
      dismissible={result === null}
      title={result ? '新密码已生成' : `重置 ${user?.username ?? ''} 的密码`}
      description={
        result
          ? '这是本次唯一一次显示明文密码。关闭后只能重新重置。'
          : '重置后该用户的所有登录会话会立即失效。'
      }
      footer={
        result ? (
          <>
            <Button variant="outline" onClick={() => void copy()}>
              <Icon name="copy" className="size-4" />
              复制密码
            </Button>
            <Button onClick={close}>我已保存</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              取消
            </Button>
            <Button disabled={reset.isPending || (mode === 'custom' && password.length === 0)} onClick={() => reset.mutate()}>
              {reset.isPending ? '处理中…' : '重置密码'}
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
            {result.generated ? '密码由服务端随机生成。' : '密码为你手动指定的值。'}请通过可信渠道转交给用户，并提醒其登录后立即修改。
          </p>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="grid gap-2 sm:grid-cols-2">
            {(
              [
                { value: 'generate', label: '随机生成', hint: '16 位，去掉易混字符' },
                { value: 'custom', label: '手动指定', hint: '需要满足密码策略' },
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
                <span className="block">{option.label}</span>
                <span className="mt-0.5 block text-xs font-normal text-muted-foreground">{option.hint}</span>
              </button>
            ))}
          </div>
          {mode === 'custom' ? (
            <TextField
              label="新密码"
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
  const [strategy, setStrategy] = useState<'delete' | 'keep'>('delete');

  const remove = useMutation({
    mutationFn: () => adminApi.deleteUser(user!.uid, strategy),
    onSuccess: () => {
      toast.success('用户已删除');
      onDone();
      onClose();
    },
    onError: (error) => {
      toast.error(error instanceof Error ? error.message : '删除失败');
    },
  });

  return (
    <Modal
      open={Boolean(user)}
      onClose={onClose}
      title={`删除 ${user?.username ?? ''}？`}
      description="账号与登录会话会被立即移除，此操作不可撤销。"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            取消
          </Button>
          <Button variant="destructive" disabled={remove.isPending} onClick={() => remove.mutate()}>
            {remove.isPending ? '删除中…' : '确认删除'}
          </Button>
        </>
      }
    >
      <SelectField
        label="该用户的导图"
        value={strategy}
        onChange={(event) => setStrategy(event.target.value as 'delete' | 'keep')}
        options={[
          { value: 'delete', label: '一并删除' },
          { value: 'keep', label: '保留（转为无主）' },
        ]}
        hint="导图数据将在 M2 引入；当前两种选择效果相同。"
      />
    </Modal>
  );
}
