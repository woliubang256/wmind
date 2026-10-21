import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '@/lib/utils';
import { Select, type SelectOption } from './select';

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => (
    <input
      ref={ref}
      className={cn(
        'h-11 w-full rounded-xl border border-input bg-background px-3 font-normal outline-none transition',
        'placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  ),
);
Input.displayName = 'Input';

interface FieldProps {
  label: string;
  /** 字段级错误。为空时不渲染错误行。 */
  error?: string;
  hint?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}

/**
 * 表单字段容器：标签 + 控件 + 错误/提示。
 *
 * 错误用 `role="alert"` 而不是普通文本：屏幕阅读器会在出现时朗读它，
 * 视觉用户看到的是红字——两种用户都要知道「这里错了」。
 */
export function Field({ label, error, hint, htmlFor, children, className }: FieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      <label htmlFor={htmlFor} className="block text-sm font-medium">
        {label}
      </label>
      {children}
      {error ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}

type TextFieldProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'id'> & {
  label: string;
  error?: string;
  hint?: ReactNode;
};

/**
 * 带标签的输入框。
 *
 * 标签与控件的 id 由同一个 `useId()` 生成：分开写时只要漏一个，
 * 点标签就不会聚焦到输入框——这种缺陷不会报错，只会让人觉得「不好用」。
 */
export function TextField({ label, error, hint, className, ...props }: TextFieldProps) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id} className={className}>
      <Input id={id} aria-invalid={error ? true : undefined} {...props} />
    </Field>
  );
}

/**
 * 多行输入。
 *
 * 这里仍然是原生 `<textarea>`——**这不是偷懒**：shadcn 的 `Textarea` 也是原生
 * 元素加自定义样式。多行文本的输入法、选区、撤销栈、自动滚动全在浏览器内核里，
 * 换成 contenteditable 之后中文输入法的候选框定位与撤销行为都会变差。
 * 「不要原生」针对的是**原生外观**（系统绘制的方角、系统滚动条、系统 resize 角），
 * 这些都已经在这一层覆盖掉了。
 */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(
  ({ className, rows = 3, ...props }, ref) => (
    <textarea
      ref={ref}
      rows={rows}
      className={cn(
        'w-full resize-y rounded-xl border border-input bg-background px-3 py-2 font-normal outline-none transition',
        'placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring',
        'aria-[invalid=true]:border-destructive aria-[invalid=true]:ring-destructive/30',
        'disabled:cursor-not-allowed disabled:opacity-60',
        className,
      )}
      {...props}
    />
  ),
);
Textarea.displayName = 'Textarea';

type TextareaFieldProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'id'> & {
  label: string;
  error?: string;
  hint?: ReactNode;
};

export function TextareaField({ label, error, hint, className, ...props }: TextareaFieldProps) {
  const id = useId();
  return (
    <Field label={label} error={error} hint={hint} htmlFor={id} className={className}>
      <Textarea id={id} aria-invalid={error ? true : undefined} {...props} />
    </Field>
  );
}

type SelectFieldProps<T extends string> = {
  label: string;
  value: T;
  options: readonly SelectOption<T>[];
  onChange: (value: T) => void;
  error?: string;
  hint?: ReactNode;
  className?: string;
  id?: string;
  disabled?: boolean;
  placeholder?: string;
};

/**
 * 带标签的下拉。
 *
 * `onChange` 直接给**值**而不是事件对象：调用方九成只想 `setX(value)`，
 * 拿事件的人得自己 `event.target.value` 再断言类型，每次都要写一遍。
 */
export function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
  error,
  hint,
  className,
  id,
  disabled,
  placeholder,
}: SelectFieldProps<T>) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  return (
    <Field label={label} error={error} hint={hint} htmlFor={selectId} className={className}>
      <Select
        id={selectId}
        value={value}
        options={options}
        onChange={onChange}
        disabled={disabled}
        placeholder={placeholder}
        invalid={error !== undefined}
      />
    </Field>
  );
}
