"use client";

import type { ReactNode } from "react";

export type FormOption = {
  id: number;
  label: string;
  value?: string;
  /** Shown but unselectable — an option a reader should see and understand, not one that
   *  vanishes. The server still refuses it; this is presentation. */
  disabled?: boolean;
};

export function FieldRow({
  label,
  name,
  error,
  hint,
  required,
  children,
  className = "",
}: {
  label: string;
  name: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <label className="label" htmlFor={name}>
        {label}
        {required && <span className="ml-0.5 text-red-500">*</span>}
      </label>
      {children}
      {error ? (
        <p id={`${name}-error`} role="alert" className="mt-1 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p className="mt-1 text-xs text-ink-400">{hint}</p>
      ) : null}
    </div>
  );
}

export function Text({
  name, label, defaultValue, error, hint, required, type = "text",
  placeholder, inputMode, maxLength, min, max, step, className = "",
}: {
  name: string;
  label: string;
  defaultValue?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  type?: string;
  placeholder?: string;
  inputMode?: "text" | "numeric" | "tel" | "email" | "decimal";
  maxLength?: number;
  min?: number;
  max?: number;
  step?: string;
  className?: string;
}) {
  return (
    <FieldRow label={label} name={name} error={error} hint={hint} required={required} className={className}>
      <input
        id={name}
        name={name}
        type={type}
        defaultValue={defaultValue}
        placeholder={placeholder}
        inputMode={inputMode}
        maxLength={maxLength}
        min={min}
        max={max}
        step={step}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className="field"
      />
    </FieldRow>
  );
}

export function Select({
  name, label, options, defaultValue, error, hint, required,
  placeholder = "Select…", onChange, value, className = "", ref,
}: {
  name: string;
  label: string;
  options: FormOption[];
  defaultValue?: string;
  error?: string;
  hint?: string;
  required?: boolean;
  placeholder?: string;
  onChange?: (e: React.ChangeEvent<HTMLSelectElement>) => void;
  value?: string;
  className?: string;
  ref?: React.Ref<HTMLSelectElement>;
}) {
  return (
    <FieldRow label={label} name={name} error={error} hint={hint} required={required} className={className}>
      <select
        ref={ref}
        id={name}
        name={name}
        defaultValue={value === undefined ? defaultValue : undefined}
        value={value}
        onChange={onChange}
        required={required}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${name}-error` : undefined}
        className="field"
      >
        <option value="">{placeholder}</option>
        {options.map((o) => (
          <option key={o.id} value={o.id} disabled={o.disabled}>{o.label}</option>
        ))}
      </select>
    </FieldRow>
  );
}

export function TextArea({
  name, label, defaultValue, error, hint, rows = 3, placeholder, className = "",
}: {
  name: string;
  label: string;
  defaultValue?: string;
  error?: string;
  hint?: string;
  rows?: number;
  placeholder?: string;
  className?: string;
}) {
  return (
    <FieldRow label={label} name={name} error={error} hint={hint} className={className}>
      <textarea
        id={name}
        name={name}
        rows={rows}
        defaultValue={defaultValue}
        placeholder={placeholder}
        aria-invalid={error ? true : undefined}
        className="field resize-y"
      />
    </FieldRow>
  );
}

export function FormSection({
  step,
  title,
  description,
  children,
  columns = 3,
}: {
  step: number;
  title: string;
  description?: string;
  children: ReactNode;
  columns?: 2 | 3;
}) {
  return (
    <section className="rounded-card border border-line bg-surface shadow-card">
      <div className="flex items-start gap-3 border-b border-line px-5 py-3.5">
        <span className="tnum mt-px flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-brand-50 text-[0.68rem] font-semibold text-brand-700 ring-1 ring-brand-200">
          {step}
        </span>
        <div>
          <h2 className="text-sm font-semibold tracking-tight text-ink-900">{title}</h2>
          {description && <p className="mt-0.5 text-xs text-ink-500">{description}</p>}
        </div>
      </div>
      <div
        className={`grid gap-x-5 gap-y-4 p-5 sm:grid-cols-2 ${
          columns === 3 ? "lg:grid-cols-3" : ""
        }`}
      >
        {children}
      </div>
    </section>
  );
}
