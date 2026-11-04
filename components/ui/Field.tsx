"use client";
import { useId } from "react";
import { cn } from "./cn";

const inputCls =
  "w-full rounded-chip border border-line-strong bg-white px-4 text-body text-ink placeholder:text-ink-muted/80 min-h-[48px] focus-visible:border-ink";

export function TextField({
  label,
  hint,
  error,
  className,
  ...rest
}: { label: string; hint?: string; error?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-small font-semibold">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined}
        className={cn(inputCls, error && "border-danger")}
        {...rest}
      />
      {hint && !error && (
        <p id={`${id}-h`} className="mt-1.5 text-small text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-e`} role="alert" className="mt-1.5 text-small font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}

export function TextAreaField({
  label,
  hint,
  error,
  className,
  ...rest
}: { label: string; hint?: string; error?: string } & React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const id = useId();
  return (
    <div className={className}>
      <label htmlFor={id} className="mb-1.5 block text-small font-semibold">
        {label}
      </label>
      <textarea
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-e` : hint ? `${id}-h` : undefined}
        className={cn(inputCls, "py-3 leading-6 min-h-[140px] resize-y", error && "border-danger")}
        {...rest}
      />
      {hint && !error && (
        <p id={`${id}-h`} className="mt-1.5 text-small text-ink-muted">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${id}-e`} role="alert" className="mt-1.5 text-small font-semibold text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
