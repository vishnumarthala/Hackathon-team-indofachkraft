-- 015: persist the parent voice note email result so the Report tab shows it after reload. Additive only.
alter table reports
  add column if not exists email_status text
  check (email_status in ('sent', 'demo', 'no_email', 'failed'));
