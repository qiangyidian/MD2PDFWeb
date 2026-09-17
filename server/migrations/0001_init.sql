-- 0001_init：账号 / 会话 / 额度 / 兑换码
-- 幂等：全部 IF NOT EXISTS，可重复执行

CREATE TABLE IF NOT EXISTS users (
  id            uuid PRIMARY KEY,
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS sessions (
  token_id     text PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_last_seen_idx ON sessions (last_seen_at);

CREATE TABLE IF NOT EXISTS quota_accounts (
  user_id    uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  remaining  integer NOT NULL DEFAULT 0 CHECK (remaining >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS quota_ledger (
  id             uuid PRIMARY KEY,
  user_id        uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  entry_type     text NOT NULL,
  amount         integer NOT NULL,
  remaining      integer NOT NULL,
  note           text NOT NULL DEFAULT '',
  reference_type text NOT NULL DEFAULT '',
  reference_id   text NOT NULL DEFAULT '',
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quota_ledger_user_idx ON quota_ledger (user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS uq_quota_ledger_reference
  ON quota_ledger (reference_type, reference_id) WHERE reference_id <> '';

CREATE TABLE IF NOT EXISTS redeem_codes (
  id         uuid PRIMARY KEY,
  code       text NOT NULL UNIQUE,
  value      integer NOT NULL CHECK (value > 0),
  batch_id   uuid NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  status     text NOT NULL DEFAULT 'unused' CHECK (status IN ('unused', 'used', 'revoked')),
  used_by    uuid REFERENCES users(id) ON DELETE SET NULL,
  used_at    timestamptz,
  used_ip    text,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users(id) ON DELETE SET NULL,
  note       text NOT NULL DEFAULT '',
  CONSTRAINT ck_redeem_used CHECK (
    status <> 'used' OR (used_by IS NOT NULL AND used_at IS NOT NULL)
  )
);
CREATE INDEX IF NOT EXISTS redeem_codes_batch_idx ON redeem_codes (batch_id);
CREATE INDEX IF NOT EXISTS redeem_codes_status_idx ON redeem_codes (status, created_at DESC);
