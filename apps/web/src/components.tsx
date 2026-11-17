import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  ArrowLeft,
  ArrowUpRight,
  Check,
  ChevronRight,
  Circle,
  Clock3,
  GitBranch,
  LoaderCircle,
  ShieldCheck,
  X,
} from 'lucide-react';
import { Link } from 'react-router-dom';
import type { DashboardRepository } from '@opticpr/contracts';
import { errorMessage } from './api';

export function Mark({ small = false }: { small?: boolean }) {
  return (
    <span className={`brand-mark ${small ? 'small' : ''}`} aria-hidden="true">
      <svg viewBox="0 0 32 32" fill="none">
        <circle
          cx="16"
          cy="16"
          r="11"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path
          d="M16 5 23 17 16 27 9 15Z"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <path
          d="m6 12 20 8M6 20l20-8"
          stroke="currentColor"
          strokeWidth="1.3"
        />
        <circle cx="16" cy="16" r="3" fill="currentColor" />
      </svg>
    </span>
  );
}
const statusLabels: Record<string, string> = {
  new: 'New',
  still_present: 'Still present',
  needs_verification: 'Needs verification',
  cleared_by_recheck: 'Cleared by recheck',
  completed: 'Completed',
  queued: 'Queued',
  running: 'Reviewing',
  failed: 'Failed',
  cancelled: 'Cancelled',
  complete: 'Complete',
  partial: 'Partial review',
  unknown: 'Coverage unknown',
  skipped: 'Skipped',
  high: 'High severity',
  medium: 'Medium severity',
  low: 'Low severity',
  dismiss: 'Dismissed',
  reopen: 'Reopened',
  pending: 'Pending',
  published: 'Published',
  waiting: 'Waiting',
  superseded: 'Superseded',
};
export function Status({
  value,
  children,
}: {
  value: string;
  children?: ReactNode;
}) {
  const Icon = [
    'completed',
    'complete',
    'cleared_by_recheck',
    'published',
  ].includes(value)
    ? Check
    : ['queued', 'running', 'pending', 'waiting'].includes(value)
      ? Clock3
      : ['failed', 'needs_verification', 'partial', 'unknown'].includes(value)
        ? AlertCircle
        : Circle;
  return (
    <span className={`status status-${value}`}>
      <Icon size={12} strokeWidth={2} />
      {children ?? statusLabels[value] ?? value}
    </span>
  );
}
export const shortSha = (sha?: string | null) => sha?.slice(0, 7) ?? '—';
export function when(value?: string | null) {
  return value
    ? new Intl.DateTimeFormat(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(new Date(value))
    : 'No events yet';
}
export function Revision({ base, head }: { base: string; head: string }) {
  return (
    <span className="revision">
      <GitBranch size={13} />
      <code title={base}>{shortSha(base)}</code>
      <span className="revision-arrow">→</span>
      <code title={head}>{shortSha(head)}</code>
    </span>
  );
}
export function Breadcrumb({
  repository,
  number,
}: {
  repository?: DashboardRepository;
  number?: number;
}) {
  return (
    <nav className="breadcrumb" aria-label="Breadcrumb">
      <Link to="/repos">Repositories</Link>
      {repository && (
        <>
          <ChevronRight size={13} />
          <Link to={`/repos/${repository.id}`}>
            {repository.owner} / {repository.name}
          </Link>
        </>
      )}
      {number && (
        <>
          <ChevronRight size={13} />
          <span>PR #{number}</span>
        </>
      )}
    </nav>
  );
}
export function External({
  href,
  children,
  className = 'button secondary',
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <a className={className} href={href} target="_blank" rel="noreferrer">
      {children}
      <ArrowUpRight size={14} />
      <span className="sr-only"> (opens in a new tab)</span>
    </a>
  );
}
export function Loading({
  label = 'Bringing your reviews into focus',
}: {
  label?: string;
}) {
  return (
    <div className="loading" role="status">
      <LoaderCircle className="spin" size={24} />
      <p>{label}…</p>
      <div className="skeleton" />
      <div className="skeleton short" />
    </div>
  );
}
export function Empty({
  title,
  children,
  icon = 'check',
}: {
  title: string;
  children: ReactNode;
  icon?: 'check' | 'shield';
}) {
  return (
    <div className="empty-state">
      <span className="empty-icon">
        {icon === 'check' ? <Check size={24} /> : <ShieldCheck size={24} />}
      </span>
      <h2>{title}</h2>
      <div className="muted">{children}</div>
    </div>
  );
}
export function Failure({
  error,
  retry,
}: {
  error: unknown;
  retry?: () => void;
}) {
  const status =
    error && typeof error === 'object' && 'status' in error
      ? error.status
      : undefined;
  return (
    <div className="empty-state" role="alert">
      <span className="empty-icon error">
        <AlertCircle size={24} />
      </span>
      <h2>
        {status === 404 || status === 403
          ? 'This review is out of reach'
          : 'Something interrupted the view'}
      </h2>
      <p className="muted">{errorMessage(error)}</p>
      <div className="actions">
        <Link className="button secondary" to="/repos">
          <ArrowLeft size={14} />
          Repositories
        </Link>
        {retry && (
          <button className="button primary" onClick={retry}>
            Try again
          </button>
        )}
      </div>
    </div>
  );
}
export function ActionDialog({
  title,
  description,
  label,
  submit,
  close,
}: {
  title: string;
  description: string;
  label: string;
  submit: (reason: string, id: string) => Promise<unknown>;
  close: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [reason, setReason] = useState('');
  const [id, setId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>();
  useLayoutEffect(() => {
    const trigger = document.activeElement;
    const element = dialog.current;
    element?.showModal();
    return () => {
      if (element?.open) element.close();
      if (trigger instanceof HTMLElement && document.contains(trigger)) {
        if (trigger.matches(':disabled'))
          document.getElementById('revision-select')?.focus();
        else trigger.focus();
      }
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="action-dialog"
      aria-modal="true"
      aria-labelledby="action-title"
      onCancel={(event) => {
        if (busy) event.preventDefault();
        else close();
      }}
    >
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setBusy(true);
          setError(undefined);
          try {
            await submit(reason, id);
            close();
          } catch (failure) {
            setError(failure);
          } finally {
            setBusy(false);
          }
        }}
      >
        <div className="dialog-head">
          <span className="eyebrow">MAINTAINER ACTION</span>
          <button
            type="button"
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={close}
          >
            <X size={18} />
          </button>
        </div>
        <h2 id="action-title">{title}</h2>
        <p className="muted">{description}</p>
        <label className="field-label" htmlFor="action-reason">
          Reason <span className="muted">· required</span>
        </label>
        <textarea
          id="action-reason"
          autoFocus
          required
          maxLength={2000}
          rows={4}
          value={reason}
          placeholder="Add context for the next reviewer…"
          onChange={(event) => {
            setReason(event.target.value);
            setId(crypto.randomUUID());
          }}
        />
        {error !== undefined && (
          <p className="form-error" role="alert">
            {errorMessage(error)}
          </p>
        )}
        <div className="dialog-actions">
          <button
            type="button"
            className="button secondary"
            disabled={busy}
            onClick={close}
          >
            Cancel
          </button>
          <button className="button primary" disabled={busy || !reason.trim()}>
            {busy && <LoaderCircle size={14} className="spin" />}
            {busy ? 'Saving…' : label}
          </button>
        </div>
      </form>
    </dialog>
  );
}
