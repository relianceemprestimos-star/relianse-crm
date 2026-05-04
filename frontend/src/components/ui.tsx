import type {
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'success';

function joinClasses(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(' ');
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={joinClasses(
        'rounded-3xl border border-border/80 bg-panel/90 shadow-glow backdrop-blur-sm',
        className
      )}
      {...props}
    />
  );
}

export function Button({
  className,
  variant = 'primary',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const base =
    'inline-flex items-center justify-center gap-2 rounded-2xl px-4 py-3 text-sm font-semibold transition-all duration-200 focus:outline-none focus:ring-2 focus:ring-accent/40 disabled:cursor-not-allowed disabled:opacity-50';
  const variants: Record<Variant, string> = {
    primary: 'bg-accent text-slate-950 hover:brightness-110 hover:shadow-[0_0_24px_rgba(0,209,193,.28)]',
    secondary: 'border border-border bg-panelAlt text-slate-100 hover:border-accent/40 hover:bg-accent/10',
    ghost: 'bg-transparent text-slate-200 hover:bg-white/5',
    danger: 'bg-danger text-white hover:brightness-110',
    success: 'bg-success text-white hover:brightness-110',
  };

  return <button className={joinClasses(base, variants[variant], className)} {...props} />;
}

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={joinClasses(
        'w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10 placeholder:text-slate-500',
        className
      )}
      {...props}
    />
  );
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={joinClasses(
        'w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10 placeholder:text-slate-500',
        className
      )}
      {...props}
    />
  );
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={joinClasses(
        'w-full rounded-2xl border border-border bg-bg/80 px-4 py-3 text-sm text-slate-100 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/10',
        className
      )}
      {...props}
    />
  );
}

export function Badge({
  children,
  tone = 'neutral',
  className,
}: {
  children: ReactNode;
  tone?: 'neutral' | 'accent' | 'success' | 'danger' | 'info';
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: 'bg-white/5 text-slate-300 border-white/10',
    accent: 'bg-accent/15 text-accent border-accent/20',
    success: 'bg-success/15 text-green-300 border-success/20',
    danger: 'bg-danger/15 text-red-300 border-danger/20',
    info: 'bg-info/15 text-blue-300 border-info/20',
  };

  return (
    <span className={joinClasses('inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold', tones[tone], className)}>
      {children}
    </span>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon?: ReactNode;
}) {
  return (
    <Card className="p-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm text-slate-400">{label}</p>
          <p className="mt-2 text-3xl font-bold tracking-tight text-white">{value}</p>
          {hint ? <p className="mt-2 text-xs text-slate-500">{hint}</p> : null}
        </div>
        {icon ? <div className="rounded-2xl border border-white/8 bg-white/5 p-3 text-accent">{icon}</div> : null}
      </div>
    </Card>
  );
}

export function SectionHeader({
  title,
  description,
  action,
}: {
  title: string;
  description?: string;
  action?: ReactNode;
}) {
  return (
    <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
      <div>
        <h2 className="text-2xl font-bold text-white">{title}</h2>
        {description ? <p className="mt-1 max-w-3xl text-sm text-slate-400">{description}</p> : null}
      </div>
      {action ? <div>{action}</div> : null}
    </div>
  );
}

export function Modal({
  open,
  title,
  description,
  onClose,
  children,
  widthClass = 'max-w-2xl',
}: {
  open: boolean;
  title: string;
  description?: string;
  onClose: () => void;
  children: ReactNode;
  widthClass?: string;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/80 px-4 backdrop-blur-sm">
      <div className={joinClasses('w-full rounded-3xl border border-border bg-panel p-6 shadow-glow', widthClass)}>
        <div className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h3 className="text-xl font-bold text-white">{title}</h3>
            {description ? <p className="mt-1 text-sm text-slate-400">{description}</p> : null}
          </div>
          <button
            onClick={onClose}
            className="rounded-2xl border border-border bg-white/5 px-3 py-2 text-sm text-slate-300 transition hover:bg-white/10"
          >
            Fechar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
