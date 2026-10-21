/**
 * 崩溃兜底页与全局错误边界。
 *
 * 没有它们的时候，任何一处渲染期异常都会让 React 卸载整棵树——用户看到的是一张
 * 纯白页面，控制台里躺着一条没人会去看的堆栈。这正是「编辑器打开就白屏」这类
 * 问题最典型的现场（`RemoteEditor` 里那句 `parseDocument` 的注释就是为此写的）。
 *
 * **两层**都要有，缺一不可：
 *
 * - 路由层（`RouteCrash`）：`createBrowserRouter` 自带的默认错误页是一张
 *   「Unexpected Application Error」的英文堆栈，对用户毫无意义。给顶层路由挂
 *   `errorElement` 之后，子路由的渲染错误冒到这里，套用自己的页面。
 * - 应用层（`ErrorBoundary` 类组件）：路由之外的壳（Providers、QueryClient、
 *   SiteHead）崩了没有路由可以兜。类组件是硬要求——函数组件做不到错误边界。
 *
 * 三条设计约束：
 *
 * 1. **必须能自己恢复**：刷新是唯一可靠的恢复手段（应用状态已经不可信），所以
 *    主按钮就是「刷新页面」；「返回首页」留给「刷新后仍然崩」的情况。
 * 2. **必须能报障**：错误编号 + 原始消息放在可折叠的详情里，用户复制给维护者
 *    就能对上控制台里那条日志。编号用随机短串而不是自增，避免泄露「这是第几次
 *    崩溃」这种无从解释的信息。
 * 3. **文案不能成为新的崩溃路径**：这一页要在「别的代码都挂了」的情况下还能
 *    渲染。原先的做法是整页写死中文——安全，但英文用户看到的是中文报错页。
 *    现在走 `tr()`：内部是 `i18n.t` 包一层 try/catch，取不到翻译就退回中文
 *    字面量。i18n 正常时跟随语言，i18n 自己坏了时与从前行为一致，两条路都
 *    不会抛。
 */

import { Component, useEffect, useState, type ErrorInfo, type PropsWithChildren } from 'react';
import { useRouteError } from 'react-router';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';
import i18n from '@/lib/i18n';

/**
 * 取一条翻译，取不到就用中文兜底。
 *
 * 两个兜底都要：`i18n.t` 在 i18n 未初始化时会抛（`isInitialized` 检查），
 * 而 `returnNull: false` 时找不到键会把键原样返回——那会让报错页上出现
 * `crash.title` 这种比中文更难懂的东西。
 */
function tr(key: string, fallback: string, options?: Record<string, unknown>): string {
  try {
    const text = i18n.t(key, options);
    return typeof text === 'string' && text !== '' && text !== key ? text : fallback;
  } catch {
    return fallback;
  }
}

/** 本次崩溃的短编号：同时打进控制台与界面，用户报障时对得上。 */
function newIncidentId(): string {
  // 不引第三方 id 库：这里只需要「短、可读、不重复」，时间戳 + 随机四位足够。
  return `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return tr('crash.unknown', '未知错误（错误对象不是 Error 实例）');
}

interface CrashViewProps {
  error: unknown;
  incident: string;
  componentStack?: string | null;
}

function CrashView({ error, incident, componentStack }: CrashViewProps) {
  return (
    <div className="grid min-h-svh place-items-center bg-background px-6 py-12 text-foreground">
      <div className="w-full max-w-lg">
        <span className="mx-auto grid size-12 place-items-center rounded-2xl bg-destructive/10 text-destructive">
          <Icon name="alert" className="size-5" />
        </span>
        <h1 className="mt-4 text-center text-lg font-semibold">{tr('crash.title', '页面出错了')}</h1>
        <p className="mt-2 text-center text-sm leading-6 text-muted-foreground">
          {tr(
            'crash.body',
            '刚才这一步没能完成，页面已经停下以免弄坏你的数据。刷新通常就能恢复；如果反复出现，请把下面的错误编号一并反馈。',
          )}
        </p>

        <div className="mt-4 flex justify-center gap-2">
          <Button onClick={() => window.location.reload()}>{tr('crash.reload', '刷新页面')}</Button>
          <Button variant="outline" onClick={() => window.location.assign('/')}>
            {tr('crash.home', '返回首页')}
          </Button>
        </div>

        <details className="mt-6 rounded-xl border border-border/70 bg-muted/30 px-4 py-3 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground">
            {tr('crash.details', '错误详情（编号 {{incident}}）', { incident })}
          </summary>
          <p className="mt-2 break-words font-medium text-foreground">{errorMessage(error)}</p>
          {componentStack ? (
            <pre className="mt-2 max-h-56 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-5 text-muted-foreground">
              {componentStack.trim()}
            </pre>
          ) : null}
          <p className="mt-2 text-muted-foreground">
            {tr(
              'crash.draftHint',
              '未保存的修改可能还在本地草稿里：回到编辑器时若出现「发现本地修改」的提示，选择恢复即可。',
            )}
          </p>
        </details>
      </div>
    </div>
  );
}

/**
 * 路由层的兜底页。挂在路由树的顶层 `errorElement` 上。
 *
 * `useRouteError` 拿到的可能是 Error，也可能是路由抛出的响应（比如 404 的
 * `Response`），所以这里只认 Error / string，其余给一句通用的。
 */
export function RouteCrash() {
  const error = useRouteError();
  const [incident] = useState(newIncidentId);

  useEffect(() => {
    console.error(`[wmind] 路由渲染错误 #${incident}`, error);
  }, [incident, error]);

  return <CrashView error={error} incident={incident} />;
}

interface ErrorBoundaryState {
  error: Error | null;
  incident: string;
  componentStack: string | null;
}

/** 应用层错误边界：兜住路由之外（Providers、壳、SiteHead）的崩溃。 */
export class ErrorBoundary extends Component<PropsWithChildren, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null, incident: '', componentStack: null };

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { error, incident: newIncidentId() };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // 日志写在 componentDidCatch（React 允许副作用的唯一位置），
    // `getDerivedStateFromError` 只改 state。
    console.error(`[wmind] 渲染错误 #${this.state.incident}`, error, info.componentStack);
    this.setState({ componentStack: info.componentStack ?? null });
  }

  render() {
    const { error, incident, componentStack } = this.state;
    if (!error) return this.props.children;
    return <CrashView error={error} incident={incident} componentStack={componentStack} />;
  }
}
